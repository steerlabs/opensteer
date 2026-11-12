import type {
  HostApiCommandInput,
  HostApiCommandOutput,
  RpcCallOptions,
} from "@opensteer/protocol";
import { createHostNetwork } from "../platform/host-network.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { NotificationPreviews } from "../notifications/notification-preview.js";
import { addPersonalDeployment } from "./add-deployment.js";
import { savedViewFixture } from "../../test-support/saved-views.js";
import {
  HostSessionExchangeError,
  type HostSessionExchangeFailure,
  type NativeOAuthIdentity,
} from "@opensteer/client/auth";
import type { DeploymentConnectionInput, PrivateFilesystem } from "@opensteer/client/connections";
import { createMockHostPort } from "./mock-host-port.js";
import { mockDeploymentConnections } from "./mock-mode.js";
import {
  HostClientRequestError,
  createHttpHostApiClient,
  createMemorySavedViews,
  unwrapRpcResult,
} from "@opensteer/client/host";
import { HostTransportError } from "@opensteer/client/connections";
import { MockDesktopUpdates, MockHostClient } from "@opensteer/client/mock";
import {
  buildNativeIntegrationAuthorizationCallback,
  IntegrationAuthorizationCancelledError,
  IntegrationAuthorizationCancelUnconfirmedError,
  IntegrationOAuthAttemptIdSchema,
  IntegrationAuthorizationAttemptIdSchema,
} from "@opensteer/client/integrations";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import {
  createId,
  opensteerMobileAccountOAuthCallback,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { SessionExchangeResponseSchema } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDeploymentConnection } from "../../test-support/deployment-fixtures.js";
import { MemorySecureStore } from "../platform/memory-secure-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import { createDeploymentCredentials } from "./deployment-credentials.js";
import type { HostEpochAgreement, MobileHostPort, MobileHostPortFactory } from "./host-port.js";
import { MobileClient, type MobileClientOptions } from "./mobile-client.js";
import { IphoneAppsController } from "../iphone-apps/controller.js";
import { createFakeIphoneApps } from "../iphone-apps/fake-bridge.js";

const oauthIdentity: NativeOAuthIdentity = {
  accountCallback: opensteerMobileAccountOAuthCallback,
  application: "mobile",
  clientId: opensteerMobileOAuthClientId,
  hostCallback: opensteerMobileHostOAuthCallback,
};

const savedViewCleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of savedViewCleanup.splice(0)) close();
});

const serverId = "dep_0192f4a1-1111-4000-8000-000000000001";
const otherId = "dep_0192f4a1-4444-4000-8000-000000000004";

/**
 * The Host, as far as this file is concerned: what was attached, what was
 * disposed, and whether a credential is held. Nothing here speaks to a network;
 * the attachment decisions are what these tests are about.
 */
function testPort(options: {
  readonly held: boolean;
  /** Makes every attachment refuse the commands it is asked to send. */
  readonly refusesCommands?: boolean;
  /**
   * Read credentials from the real OAuth manager and session store instead of
   * answering a constant, so a sign-out is observed rather than simulated.
   */
  readonly realCredentials?: boolean;
  readonly verification?: HostEpochAgreement;
  readonly configureClient?: (client: MockHostClient) => void;
}) {
  const attached: { deploymentId: string; origin: string }[] = [];
  const capabilityReaders: Parameters<MobileHostPort["attach"]>[0]["capabilities"][] = [];
  /** Every command any attachment was asked to send. */
  const commands: string[] = [];
  const credentialRequests: string[] = [];
  const disposed: string[] = [];
  /** Every route a version verification was actually asked about. */
  const verified: string[] = [];
  /** Makes the most recent attachment answer the way a refused Host does. */
  const refusals: (() => void)[] = [];
  const factory: MobileHostPortFactory = ({ oauth, sessions }): MobileHostPort => ({
    credentials:
      options.realCredentials === true
        ? createDeploymentCredentials({ now: () => new Date(), oauth, sessions })
        : {
            authorization: async (connection) => {
              credentialRequests.push(connection.authority.document.deploymentId);
              return options.held ? "Bearer test" : null;
            },
            held: async () => options.held,
          },
    attach: ({ connection, origin, capabilities }) => {
      capabilityReaders.push(capabilities);
      const deploymentId = connection.authority.document.deploymentId;
      attached.push({ deploymentId, origin });
      // A real client, so the attachment this port hands back is the shape
      // `MobileClient` actually owns and disposes.
      // No latency: `connected` is a real crossing these tests wait for.
      const hostClient = new MockHostClient({ latencyMs: 0 });
      options.configureClient?.(hostClient);
      const release = hostClient.dispose.bind(hostClient);
      hostClient.dispose = () => {
        disposed.push(deploymentId);
        release();
      };
      // The Host's refusal is the one answer the in-memory client has no way
      // to give, so it is layered over the two members `MobileClient` reads:
      // everything else still runs on the real object and its private state.
      const listeners = new Set<() => void>();
      let refused = false;
      refusals.push(() => {
        refused = true;
        for (const listener of listeners) listener();
      });
      return new Proxy(hostClient, {
        get(target, property) {
          if (property === "getSnapshot") {
            return () => ({
              ...target.getSnapshot(),
              integrationAppFinishAvailable:
                typeof options.verification === "object" &&
                "capabilities" in options.verification &&
                options.verification.capabilities.includes("integration-app-finish-v1"),
              ...(refused ? { session: "authentication-required" as const } : {}),
            });
          }
          const send: SignalledDispatch = (command, call) => {
            commands.push(command.type);
            if (options.refusesCommands === true) {
              return Promise.reject(new Error("That deployment refused the command."));
            }
            return (target.dispatch as SignalledDispatch)(command, call);
          };
          if (property === "dispatch") return send;
          // Commands sent with a signal arrive through `rpc`, where tests' `dispatch` stubs answer.
          if (property === "rpc")
            return new Proxy(target.rpc, {
              get: (rpc, name) =>
                name === "commands.dispatch"
                  ? async (command: HostApiCommandInput, call?: RpcCallOptions) => ({
                      data: await send(command, call),
                      ok: true,
                    })
                  : Reflect.get(rpc, name),
            });
          if (property === "subscribe") {
            return (listener: () => void) => {
              listeners.add(listener);
              const detach = target.subscribe(listener);
              return () => {
                listeners.delete(listener);
                detach();
              };
            };
          }
          // The real instance stays the receiver, and every method it hands
          // back is bound to it: its private fields are not reachable through
          // the proxy.
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    desktopUpdates: () => new MockDesktopUpdates(),
    verifyEpoch: async (resolved) => {
      verified.push(resolved.origin);
      return options.verification ?? { status: "compatible", capabilities: [] };
    },
  });
  return {
    attached,
    capabilityReaders,
    commands,
    credentialRequests,
    disposed,
    factory,
    refusals,
    verified,
  };
}

/**
 * The Host's token endpoint, as far as an OAuth completion needs it. Every
 * other request in these tests is an empty document.
 */
let tokenSequence = 0;
const testFetch = async (input: URL | RequestInfo): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.endsWith("/token")) return new Response("{}");
  tokenSequence += 1;
  return Response.json({
    access_token: `host-access-${tokenSequence}-${"a".repeat(20)}`,
    expires_in: 3_600,
    refresh_token: `host-refresh-${tokenSequence}-${"r".repeat(20)}`,
    token_type: "Bearer",
  });
};

/**
 * A filesystem that lets one catalog read be overtaken.
 *
 * The window this exists to open is real and narrow: a selection writes the
 * catalog and then reads it back through the fence, and between those two
 * moments anything else may have selected a different Deployment. Reproducing
 * that by racing two callers is a coin toss, so the read itself is the trigger
 * — the overtake runs on the first catalog read after a catalog write, which is
 * exactly the fence reading back what the selection just wrote.
 */
function overtakenCatalogReads(privateFiles: MemoryPrivateFilesystem) {
  const catalogFile = "deployments.json";
  let overtake: (() => Promise<void>) | null = null;
  let wroteCatalog = false;
  let running = false;
  const filesystem: PrivateFilesystem = {
    root: privateFiles.root,
    directoryEmpty: (path) => privateFiles.directoryEmpty(path),
    ensureDirectory: (path) => privateFiles.ensureDirectory(path),
    fileExists: (path) => privateFiles.fileExists(path),
    readFile: async (path, maxBytes) => {
      const pending = overtake;
      if (pending !== null && wroteCatalog && !running && path.endsWith(catalogFile)) {
        overtake = null;
        running = true;
        try {
          await pending();
        } finally {
          running = false;
        }
      }
      return privateFiles.readFile(path, maxBytes);
    },
    removeFile: (path) => privateFiles.removeFile(path),
    writeFileAtomic: async (path, content) => {
      await privateFiles.writeFileAtomic(path, content);
      if (!running && path.endsWith(catalogFile)) wroteCatalog = true;
    },
    writeFileExclusive: (path, content) => privateFiles.writeFileExclusive(path, content),
  };
  return {
    filesystem,
    /** Runs `action` immediately before the catalog is read back after a write. */
    afterNextCatalogWrite: (action: () => Promise<void>) => {
      wroteCatalog = false;
      overtake = action;
    },
  };
}

function failingSelectionWrites(privateFiles: MemoryPrivateFilesystem) {
  let fail = false;
  const filesystem: PrivateFilesystem = {
    root: privateFiles.root,
    directoryEmpty: (path) => privateFiles.directoryEmpty(path),
    ensureDirectory: (path) => privateFiles.ensureDirectory(path),
    fileExists: (path) => privateFiles.fileExists(path),
    readFile: (path, maxBytes) => privateFiles.readFile(path, maxBytes),
    removeFile: (path) => privateFiles.removeFile(path),
    writeFileAtomic: async (path, content) => {
      if (fail && path.endsWith("selection.json")) {
        fail = false;
        throw new Error("Selection storage did not answer.");
      }
      await privateFiles.writeFileAtomic(path, content);
    },
    writeFileExclusive: (path, content) => privateFiles.writeFileExclusive(path, content),
  };
  return {
    failNext: () => {
      fail = true;
    },
    filesystem,
  };
}

function blockedSelectionWrites(privateFiles: MemoryPrivateFilesystem) {
  let blocked:
    | {
        readonly release: ReturnType<typeof deferred<void>>;
        readonly started: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const filesystem: PrivateFilesystem = {
    root: privateFiles.root,
    directoryEmpty: (path) => privateFiles.directoryEmpty(path),
    ensureDirectory: (path) => privateFiles.ensureDirectory(path),
    fileExists: (path) => privateFiles.fileExists(path),
    readFile: (path, maxBytes) => privateFiles.readFile(path, maxBytes),
    removeFile: (path) => privateFiles.removeFile(path),
    writeFileAtomic: async (path, content) => {
      const pending = blocked;
      if (pending !== undefined && path.endsWith("selection.json")) {
        blocked = undefined;
        pending.started.resolve();
        await pending.release.promise;
      }
      await privateFiles.writeFileAtomic(path, content);
    },
    writeFileExclusive: (path, content) => privateFiles.writeFileExclusive(path, content),
  };
  return {
    blockNext: () => {
      const pending = { release: deferred<void>(), started: deferred<void>() };
      blocked = pending;
      return {
        release: () => pending.release.resolve(),
        started: pending.started.promise,
      };
    },
    filesystem,
  };
}

function blockedSignedOutWrites(privateFiles: MemoryPrivateFilesystem) {
  let blocked:
    | {
        readonly release: ReturnType<typeof deferred<void>>;
        readonly started: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const filesystem: PrivateFilesystem = {
    root: privateFiles.root,
    directoryEmpty: (path) => privateFiles.directoryEmpty(path),
    ensureDirectory: (path) => privateFiles.ensureDirectory(path),
    fileExists: (path) => privateFiles.fileExists(path),
    readFile: (path, maxBytes) => privateFiles.readFile(path, maxBytes),
    removeFile: (path) => privateFiles.removeFile(path),
    writeFileAtomic: async (path, content) => {
      const pending = blocked;
      if (pending !== undefined && path.endsWith("signed-out.json")) {
        blocked = undefined;
        pending.started.resolve();
        await pending.release.promise;
      }
      await privateFiles.writeFileAtomic(path, content);
    },
    writeFileExclusive: (path, content) => privateFiles.writeFileExclusive(path, content),
  };
  return {
    blockNext: () => {
      const pending = { release: deferred<void>(), started: deferred<void>() };
      blocked = pending;
      return {
        release: () => pending.release.resolve(),
        started: pending.started.promise,
      };
    },
    filesystem,
  };
}

type SignalledDispatch = (
  command: HostApiCommandInput,
  call?: RpcCallOptions,
) => Promise<HostApiCommandOutput>;

/**
 * The real RPC client and network above a recorded wire, with credential loading
 * that can be held. Only the last hop is a stand-in, and it refuses an aborted
 * signal as every platform fetch does, so what reaches `sent` truly left the phone.
 */
function heldCredentialWire() {
  const sent: string[] = [];
  const holds: Promise<void>[] = [];
  let credentialReads = 0;
  let lastSignal: AbortSignal | undefined;
  const network = createHostNetwork({
    authorization: {
      cached: () => null,
      current: async () => {
        credentialReads += 1;
        const hold = holds.shift();
        if (hold)
          await withTimeout(hold, 60_000, {
            timeoutError: () => new Error("Credential loading was never released."),
          });
        return "Bearer test";
      },
    },
    fetch: async (_input, init) => {
      init?.signal?.throwIfAborted();
      const { type } = JSON.parse(String(init?.body)) as { readonly type: string };
      sent.push(type);
      return Response.json({
        data: {
          connectionId: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          failureCode: null,
          status: type === "integration.authorization.cancel" ? "cancelled" : "completed",
          type,
        },
        ok: true,
      });
    },
    openWebSocket: () => {
      throw new Error("This wire carries no sockets.");
    },
    origin: "https://host.example.test",
  });
  const http = createHttpHostApiClient({
    baseUrl: new URL("https://host.example.test"),
    fetch: network.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return {
    credentialReads: () => credentialReads,
    /** Holds the next credential read; the call it returns lets it finish. */
    hold: () => {
      const gate = Promise.withResolvers<void>();
      holds.push(gate.promise);
      return gate.resolve;
    },
    lastSignal: () => lastSignal,
    send: (command: HostApiCommandInput, call?: RpcCallOptions) => {
      lastSignal = call?.signal;
      return http["commands.dispatch"](command, call).then(unwrapRpcResult);
    },
    sent: (type: string) => sent.filter((candidate) => candidate === type),
  };
}

function open(
  port: MobileHostPortFactory,
  privateFiles: PrivateFilesystem = new MemoryPrivateFilesystem(),
  options: {
    readonly notificationPreviews?: NotificationPreviews;
    readonly accountOrigin?: string | null;
    readonly fetch?: MobileClientOptions["fetch"];
    readonly iphoneApps?: MobileClientOptions["iphoneApps"];
    readonly openIntegrationAuthorization?: MobileClientOptions["openIntegrationAuthorization"];
    readonly records?: MobileClientOptions["records"];
    readonly savedViewStore?: MobileClientOptions["savedViewStore"];
  } = {},
) {
  const opened: string[] = [];
  const client = new MobileClient({
    ...(options.notificationPreviews ? { notificationPreviews: options.notificationPreviews } : {}),
    accountOrigin: options.accountOrigin ?? null,
    catalogFilePath: "/private/deployments.json",
    quietSeenFilePath: "/private/quiet-seen.json",
    draftsFilePath: "/private/drafts.json",
    usageNoticesFilePath: "/private/usage-notices.json",
    fetch: options.fetch ?? testFetch,
    hostPort: port,
    ...(options.savedViewStore ? { savedViewStore: options.savedViewStore } : {}),
    ...(options.iphoneApps === undefined ? {} : { iphoneApps: options.iphoneApps }),
    oauthIdentity,
    openAuthorization: async (url) => {
      opened.push(url);
    },
    openIntegrationAuthorization:
      options.openIntegrationAuthorization ??
      (async () => {
        throw new Error("No integration authorization browser was arranged for this test.");
      }),
    privateFiles,
    randomBytes: (size) => new Uint8Array(size).fill(7),
    records:
      options.records ??
      createSecureRecordStore({ keyPrefix: "test", secureStore: new MemorySecureStore() }),
    selectionFilePath: "/private/selection.json",
    signedOutFilePath: "/private/signed-out.json",
  });
  return { client, opened, privateFiles };
}

const accountOrigin = "https://accounts.opensteer.test";
const accountSubject = ControlPlaneAccountIdSchema.parse(
  "acct_0192f4a1-7777-4000-8000-000000000007",
);

function accountFetch(subject = () => accountSubject): MobileClientOptions["fetch"] {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    if (!url.endsWith("/token")) return new Response("{}");
    const form = new URLSearchParams(String(init?.body ?? ""));
    expect(form.get("grant_type")).toBe("authorization_code");
    return Response.json({
      access_token: `account-access-${"a".repeat(24)}`,
      expires_in: 3_600,
      id_token: accountIdToken(subject()),
      refresh_token: `account-refresh-${"r".repeat(24)}`,
      token_type: "Bearer",
    });
  };
}

async function signInTestAccount(client: MobileClient, opened: string[]): Promise<void> {
  await client.oauth.beginAccountSignIn();
  const authorization = new URL(opened.at(-1)!);
  const callback = new URL(opensteerMobileAccountOAuthCallback);
  callback.searchParams.set("code", "account-code");
  callback.searchParams.set("iss", accountOrigin);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  await client.oauth.handleCallback(callback.toString());
}

function accountIdToken(subject = accountSubject): string {
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1_000);
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({
    aud: opensteerMobileOAuthClientId,
    auth_time: now - 60,
    email: "mobile@opensteer.test",
    exp: now + 3_600,
    iss: accountOrigin,
    sub: subject,
  })}.${"s".repeat(86)}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** The catalog takes a connection without the timestamps it stamps itself. */
function asInput(
  connection: ReturnType<typeof testDeploymentConnection>,
): DeploymentConnectionInput {
  const {
    createdAt: _createdAt,
    lastUsedAt: _lastUsedAt,
    updatedAt: _updatedAt,
    ...input
  } = connection;
  return input;
}

const connectComputer = (generation: number): DeploymentConnectionInput =>
  asInput(
    testDeploymentConnection({
      deploymentId: serverId,
      kind: "personal",
      route: { generation, kind: "connect" },
    }),
  );

describe("MobileClient integration authorization", () => {
  it("binds the native return to the started attempt and accepts only durable Host completion", async () => {
    const begins = vi.fn();
    const providerPort = testPort({
      held: true,
      configureClient: (host) => {
        const dispatch = host.dispatch.bind(host);
        host.dispatch = async (command) => {
          if (command.type === "integration.authorization.begin") begins(command.input);
          return dispatch(command);
        };
      },
    });
    let openedLaunch = "";
    const { client } = open(providerPort.factory, new MemoryPrivateFilesystem(), {
      openIntegrationAuthorization: async (launchUrl) => {
        openedLaunch = launchUrl;
        const attemptId = new URL(launchUrl).pathname.split("/").at(-2)!;
        return buildNativeIntegrationAuthorizationCallback({
          attemptId: IntegrationOAuthAttemptIdSchema.parse(attemptId),
          deploymentId: DeploymentIdSchema.parse(serverId),
        });
      },
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);

    await expect(
      client.beginIntegrationAuthorization({ definitionId: "slack" }),
    ).resolves.toMatchObject({
      status: "completed",
      connectionId: expect.stringMatching(/^con_/u),
    });
    expect(openedLaunch).toContain(`/v1/integration-authorizations/ioa_`);
    expect(openedLaunch).toContain("ticket=");
    expect(providerPort.commands).toContain("integration.authorization.begin");
    expect(begins).toHaveBeenCalledWith(expect.not.objectContaining({ finish: "app" }));
    client.dispose();
  });

  it("requests app finish on a capable Host and deduplicates session and deep-link delivery", async () => {
    const returned = vi.fn(async (_command: { attemptId: unknown }) => ({
      type: "integration.authorization.return" as const,
      status: "completed" as const,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      connectionId: null,
      failureCode: null,
    }));
    const begins: unknown[] = [];
    const port = testPort({
      held: true,
      verification: { status: "compatible", capabilities: ["integration-app-finish-v1"] },
      configureClient: (host) => {
        const dispatch = host.dispatch.bind(host);
        host.dispatch = async (command) => {
          if (command.type === "integration.authorization.return") return returned(command);
          if (command.type === "integration.authorization.begin") begins.push(command.input);
          return dispatch(command);
        };
      },
    });
    const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
      openIntegrationAuthorization: async (url) => {
        const callback = buildNativeIntegrationAuthorizationCallback({
          deploymentId: DeploymentIdSchema.parse(serverId),
          attemptId: IntegrationOAuthAttemptIdSchema.parse(new URL(url).pathname.split("/").at(-2)),
          returnProof: "r".repeat(43),
        });
        const link = client.handleIntegrationAuthorizationCallback(callback);
        await link;
        return callback;
      },
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    await expect(
      client.beginIntegrationAuthorization({ definitionId: "slack" }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(begins).toEqual([expect.objectContaining({ finish: "app", surface: "native" })]);
    expect(returned).toHaveBeenCalledOnce();
    client.dispose();
  });

  it.each(["recover", "408", "dispose", "expire", "refuse"] as const)(
    "retains a mobile redemption proof through transient failure until %s without another callback",
    async (mode) => {
      const returned = vi
        .fn(async (_command: unknown) => ({
          type: "integration.authorization.return" as const,
          status: "completed" as const,
          connectionId: null,
          failureCode: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }))
        .mockRejectedValueOnce(
          mode === "refuse"
            ? new HostClientRequestError({ code: "forbidden", message: "Wrong owner", status: 403 })
            : mode === "408"
              ? new HostClientRequestError({
                  code: "unavailable",
                  message: "Request timed out",
                  status: 408,
                })
              : new Error("offline"),
        );
      const port = testPort({
        held: true,
        verification: { status: "compatible", capabilities: ["integration-app-finish-v1"] },
        configureClient: (host) => {
          const dispatch = host.dispatch.bind(host);
          host.dispatch = async (command) =>
            command.type === "integration.authorization.return"
              ? returned(command)
              : dispatch(command);
        },
      });
      const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
        openIntegrationAuthorization: async (url) =>
          buildNativeIntegrationAuthorizationCallback({
            deploymentId: DeploymentIdSchema.parse(serverId),
            attemptId: IntegrationOAuthAttemptIdSchema.parse(
              new URL(url).pathname.split("/").at(-2),
            ),
            returnProof: "r".repeat(43),
          }),
      });
      await client.catalog.upsert(
        asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
      );
      await client.initialize();
      await client.select(serverId);
      vi.useFakeTimers();
      try {
        const outcome = client
          .beginIntegrationAuthorization({ definitionId: "slack" })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toHaveBeenCalledOnce();
        if (mode === "dispose") client.dispose();
        if (mode === "expire") vi.setSystemTime(Date.now() + 600_001);
        await vi.advanceTimersByTimeAsync(1000);
        if (mode === "recover" || mode === "408") {
          await expect(outcome).resolves.toMatchObject({ status: "completed" });
          expect(returned).toHaveBeenCalledTimes(2);
          expect(returned.mock.calls[1]).toEqual(returned.mock.calls[0]);
        } else {
          await expect(outcome).resolves.toMatchObject(
            mode === "expire"
              ? { status: "expired" }
              : mode === "refuse"
                ? { message: "Wrong owner" }
                : { name: "Error" },
          );
          await vi.advanceTimersByTimeAsync(30_000);
          expect(returned).toHaveBeenCalledOnce();
        }
      } finally {
        client.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { failure: "discovery", mode: "recover" },
    { failure: "discovery", mode: "retry" },
    { failure: "discovery", mode: "signed-out" },
    { failure: "discovery", mode: "expire" },
    { failure: "discovery", mode: "refuse" },
    { failure: "session-exchange", mode: "recover" },
    { failure: "session-exchange", mode: "signed-out" },
    { failure: "session-exchange", mode: "refuse" },
  ] as const)(
    "retains a mobile return proof through $failure selection failure until $mode",
    async ({ failure, mode }) => {
      const records = createSecureRecordStore({
        keyPrefix: "test",
        secureStore: new MemorySecureStore(),
      });
      let unavailable = false;
      const failedSelection = vi.fn();
      const returned = vi.fn(async (_command: unknown) => ({
        type: "integration.authorization.return" as const,
        status: "completed" as const,
        connectionId: null,
        failureCode: null,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }));
      const portOptions = {
        held: true,
        configureClient: (host: MockHostClient) => {
          const dispatch = host.dispatch.bind(host);
          host.dispatch = async (command) =>
            command.type === "integration.authorization.return"
              ? returned(command)
              : dispatch(command);
        },
      };
      const port = testPort(portOptions);
      const factory: MobileHostPortFactory = (options) => {
        const host = port.factory(options);
        return {
          ...host,
          verifyEpoch: async (...args) => {
            if (unavailable && failure === "discovery") {
              failedSelection();
              return mode === "refuse" ? "identity-mismatch" : "unreachable";
            }
            return host.verifyEpoch(...args);
          },
        };
      };
      let callback = "";
      const { client } = open(factory, new MemoryPrivateFilesystem(), {
        records,
        openIntegrationAuthorization: async (url) => {
          callback = buildNativeIntegrationAuthorizationCallback({
            deploymentId: DeploymentIdSchema.parse(serverId),
            attemptId: IntegrationOAuthAttemptIdSchema.parse(
              new URL(url).pathname.split("/").at(-2),
            ),
            returnProof: "r".repeat(43),
          });
          await client.deselect();
          unavailable = true;
          if (failure === "session-exchange") portOptions.held = false;
          return callback;
        },
      });
      vi.spyOn(client.sessionExchange, "establish").mockImplementation(async () => {
        if (unavailable) {
          failedSelection();
          throw new HostSessionExchangeError(
            mode === "refuse" ? "blocked" : "unavailable",
            "Session exchange failed",
          );
        }
        portOptions.held = true;
        return sessionExchangeResponse();
      });
      await client.catalog.upsert(connectComputer(1));
      await client.initialize();
      await client.select(serverId);
      vi.useFakeTimers();
      try {
        let finished = false;
        const outcome = client
          .beginIntegrationAuthorization({ definitionId: "slack" })
          .catch((error: unknown) => error)
          .then((result) => {
            finished = true;
            return result;
          });
        await vi.advanceTimersByTimeAsync(0);
        expect(failedSelection).toHaveBeenCalledOnce();
        expect(client.getSnapshot().selection.hostClient).toBeNull();
        expect(returned).not.toHaveBeenCalled();
        if (mode === "refuse") {
          await expect(outcome).resolves.toBeInstanceOf(Error);
          expect(await records.read("integration-authorization-attempts")).toBeNull();
          unavailable = false;
          await expect(client.handleIntegrationAuthorizationCallback(callback)).resolves.toBeNull();
          await vi.advanceTimersByTimeAsync(30_000);
          expect(returned).not.toHaveBeenCalled();
          return;
        }
        expect(finished, "Transient selection failure discarded the return proof").toBe(false);
        expect(await records.read("integration-authorization-attempts")).toContain("attemptId");
        if (mode === "signed-out") await client.signOut(serverId);
        unavailable = false;
        if (mode === "recover" || mode === "retry") {
          if (mode === "recover") await client.retrySelection();
          else await vi.advanceTimersByTimeAsync(1000);
          await vi.advanceTimersByTimeAsync(0);
          expect(finished, "Ready attachment never resumed the retained return proof").toBe(true);
          await expect(outcome).resolves.toMatchObject({ status: "completed" });
          expect(returned).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              returnProof: "r".repeat(43),
              idempotencyKey: expect.stringMatching(/^integration-auth-return:/u),
            }),
          );
          expect(failedSelection).toHaveBeenCalledOnce();
        } else {
          if (mode === "expire") vi.setSystemTime(Date.now() + 600_001);
          await vi.advanceTimersByTimeAsync(1000);
          if (mode === "expire")
            await expect(outcome).resolves.toMatchObject({ status: "expired" });
          else
            await expect(outcome).resolves.toBeInstanceOf(IntegrationAuthorizationCancelledError);
          expect(await records.read("integration-authorization-attempts")).toBeNull();
          await expect(client.handleIntegrationAuthorizationCallback(callback)).resolves.toBeNull();
        }
        await vi.advanceTimersByTimeAsync(30_000);
        expect(returned).toHaveBeenCalledTimes(mode === "recover" || mode === "retry" ? 1 : 0);
      } finally {
        client.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "complete",
    "bootstrap-failed",
    "attachment-ready",
    "owner-changed",
    "selection-changed",
    "signed-out",
    "deadline",
  ] as const)(
    "resumes a persisted return only after bounded authenticated cold-start loading: %s",
    async (mode) => {
      const records = createSecureRecordStore({
        keyPrefix: "test",
        secureStore: new MemorySecureStore(),
      });
      const files = new MemoryPrivateFilesystem();
      let callback = "";
      let cold = false;
      const loaded = deferred<void>();
      const loading = vi.fn();
      const changedUserId = createId("user");
      const port = testPort({
        held: true,
        verification: { status: "compatible", capabilities: ["integration-app-finish-v1"] },
        configureClient: (host) => {
          if (cold) {
            let ready = false;
            const snapshot = host.getSnapshot.bind(host);
            const load = host.load.bind(host);
            vi.spyOn(host, "getSnapshot").mockImplementation(() => ({
              ...snapshot(),
              ...(!ready
                ? { user: null }
                : mode === "owner-changed"
                  ? { user: { ...snapshot().user!, id: changedUserId } }
                  : {}),
            }));
            host.load = async () => {
              loading();
              if (mode === "bootstrap-failed" && loading.mock.calls.length === 1)
                throw new Error("bootstrap unavailable");
              await loaded.promise;
              ready = true;
              await load();
            };
          }
          const dispatch = host.dispatch.bind(host);
          host.dispatch = async (command) =>
            command.type === "integration.authorization.return"
              ? {
                  type: "integration.authorization.return",
                  status: "completed",
                  connectionId: null,
                  expiresAt: new Date(Date.now() + 600_000).toISOString(),
                  failureCode: null,
                }
              : dispatch(command);
        },
      });
      const first = open(port.factory, files, {
        records,
        openIntegrationAuthorization: async (url) => {
          callback = buildNativeIntegrationAuthorizationCallback({
            deploymentId: DeploymentIdSchema.parse(serverId),
            attemptId: IntegrationOAuthAttemptIdSchema.parse(
              new URL(url).pathname.split("/").at(-2),
            ),
            returnProof: "r".repeat(43),
          });
          throw new Error("browser unavailable");
        },
      }).client;
      await first.catalog.upsert(
        asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
      );
      await first.initialize();
      await first.select(serverId);
      await expect(first.beginIntegrationAuthorization({ definitionId: "slack" })).rejects.toThrow(
        "browser unavailable",
      );
      first.dispose();
      cold = true;
      const second = open(port.factory, files, { records }).client;
      await second.initialize();
      if (mode === "deadline" || mode === "bootstrap-failed" || mode === "attachment-ready")
        vi.useFakeTimers();
      let finished = false;
      const outcome = second
        .handleIntegrationAuthorizationCallback(callback)
        .catch((error: unknown) => error)
        .then((result) => {
          finished = true;
          return result;
        });
      await vi.waitFor(() => expect(loading, "Cold Host never began loading").toHaveBeenCalled(), {
        timeout: 1000,
      });
      expect(
        port.commands.filter((type) => type === "integration.authorization.return"),
      ).toHaveLength(0);
      try {
        if (mode === "selection-changed") {
          await second.catalog.upsert(
            asInput(testDeploymentConnection({ kind: "personal", deploymentId: otherId })),
          );
          await second.select(otherId);
        }
        if (mode === "signed-out") await second.signOut(serverId);
        if (mode === "deadline" || mode === "bootstrap-failed" || mode === "attachment-ready") {
          if (mode === "deadline" || mode === "attachment-ready")
            await vi.advanceTimersByTimeAsync(20_000);
          loaded.resolve();
          await vi.advanceTimersByTimeAsync(mode === "attachment-ready" ? 0 : 1000);
          if (mode === "attachment-ready")
            expect(finished, "Ready attachment did not resume the retained proof").toBe(true);
          await expect(outcome).resolves.toMatchObject({ status: "completed" });
          expect(loading).toHaveBeenCalledTimes(2);
          return;
        }
        loaded.resolve();
        if (mode === "complete") {
          await expect(outcome).resolves.toMatchObject({ status: "completed" });
          expect(
            port.commands.filter((type) => type === "integration.authorization.return"),
          ).toHaveLength(1);
        } else {
          await expect(outcome).resolves.toMatchObject(
            mode === "owner-changed"
              ? { message: "That sign-in belongs to a different user." }
              : { name: "Error" },
          );
          expect(
            port.commands.filter((type) => type === "integration.authorization.return"),
          ).toHaveLength(0);
        }
      } finally {
        loaded.resolve();
        second.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "uses the same verified native return for MCP authorization (app finish: %s)",
    async (appFinish) => {
      const attemptId = IntegrationAuthorizationAttemptIdSchema.parse(
        "imo_00000000-0000-4000-8000-000000000001",
      );
      const beginMcp = vi.fn(async (_input: { requestId: unknown; surface: string }) => ({
        attemptId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        launchTicket: "a".repeat(43),
        type: "integration.mcp.authorization.begin" as const,
      }));
      const status = vi.fn(async (_attemptId: string) => ({
        connectionId: null,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        failureCode: "provider-denied",
        status: "denied" as const,
      }));
      const port = testPort({
        held: true,
        verification: {
          status: "compatible",
          capabilities: appFinish ? ["integration-app-finish-v1"] : [],
        },
        configureClient: (client) => {
          const originalDispatch = client.dispatch.bind(client);
          client.dispatch = async (command) =>
            command.type === "integration.mcp.authorization.begin"
              ? beginMcp(command.input)
              : originalDispatch(command);
          Object.defineProperty(client, "rpc", {
            value: new Proxy(client.rpc, {
              get(target, property, receiver) {
                if (property === "integration.authorization.get") {
                  return async (input: { attemptId: string }) => ({
                    ok: true,
                    data: await status(input.attemptId),
                  });
                }
                return Reflect.get(target, property, receiver);
              },
            }),
          });
        },
      });
      let opened = "";
      const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
        openIntegrationAuthorization: async (url) => {
          opened = url;
          return buildNativeIntegrationAuthorizationCallback({
            attemptId,
            deploymentId: DeploymentIdSchema.parse(serverId),
          });
        },
      });
      await client.catalog.upsert(
        asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
      );
      await client.initialize();
      await client.select(serverId);
      const requestId = createId("request");
      await expect(
        client.beginMcpIntegrationAuthorization({
          serverId: "isv_00000000-0000-4000-8000-000000000001",
          requestId,
          displayName: "My MCP account",
        }),
      ).resolves.toMatchObject({ status: "denied", failureCode: "provider-denied" });
      expect(beginMcp).toHaveBeenCalledWith(
        expect.objectContaining({ requestId, surface: "native" }),
      );
      if (appFinish)
        expect(beginMcp).toHaveBeenCalledWith(expect.objectContaining({ finish: "app" }));
      else expect(beginMcp).toHaveBeenCalledWith(expect.not.objectContaining({ finish: "app" }));
      expect(opened).toContain(`/v1/integration-authorizations/${attemptId}/launch`);
      expect(status).toHaveBeenCalledWith(attemptId);
      client.dispose();
    },
  );

  it("rejects a browser return for another attempt before reading its status", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
      openIntegrationAuthorization: async () =>
        buildNativeIntegrationAuthorizationCallback({
          attemptId: IntegrationOAuthAttemptIdSchema.parse(
            "ioa_00000000-0000-4000-8000-000000000099",
          ),
          deploymentId: DeploymentIdSchema.parse(serverId),
        }),
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);

    await expect(client.beginIntegrationAuthorization({ definitionId: "slack" })).rejects.toThrow(
      /different integration attempt/u,
    );
    client.dispose();
  });

  it("drops an unsolicited cold callback before selection or RPC", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: otherId })),
    );
    const previous = client.getSnapshot().selection.deploymentId;
    const commands = port.commands.length;
    const callback = buildNativeIntegrationAuthorizationCallback({
      attemptId: IntegrationOAuthAttemptIdSchema.parse("ioa_00000000-0000-4000-8000-000000000099"),
      deploymentId: DeploymentIdSchema.parse(otherId),
      returnProof: "r".repeat(43),
    });
    const select = vi.spyOn(client, "select");
    await expect(client.handleIntegrationAuthorizationCallback(callback)).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(client.getSnapshot().selection.deploymentId).toBe(previous);
    expect(port.commands).toHaveLength(commands);
    client.dispose();
  });
  it.each(["cancel", "sign-out"] as const)("erases persisted authority on %s", async (action) => {
    const records = createSecureRecordStore({
      keyPrefix: "test",
      secureStore: new MemorySecureStore(),
    });
    let callback = "";
    const port = testPort({ held: true });
    const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
      records,
      openIntegrationAuthorization: async (url) => {
        callback = buildNativeIntegrationAuthorizationCallback({
          deploymentId: DeploymentIdSchema.parse(serverId),
          attemptId: IntegrationOAuthAttemptIdSchema.parse(new URL(url).pathname.split("/").at(-2)),
          returnProof: "r".repeat(43),
        });
        if (action === "cancel") throw new IntegrationAuthorizationCancelledError();
        throw new Error("offline");
      },
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    await expect(client.beginIntegrationAuthorization({ definitionId: "slack" })).rejects.toThrow();
    if (action === "sign-out") await client.signOut(serverId);
    const commands = port.commands.length;
    await expect(client.handleIntegrationAuthorizationCallback(callback)).resolves.toBeNull();
    expect(port.commands).toHaveLength(commands);
    expect(await records.read("integration-authorization-attempts")).toBeNull();
    client.dispose();
  });
});

describe("MobileClient cancelling an integration sign-in", () => {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const proof = "r".repeat(43);

  const answered = (status: "cancelled" | "completed") => ({
    connectionId: status === "completed" ? "con_00000000-0000-4000-8000-0000000000aa" : null,
    expiresAt,
    failureCode: null,
    status,
    type: "integration.authorization.cancel" as const,
  });

  async function signingIn(
    input: {
      readonly answer?: "cancelled" | "completed";
      /** Answers the Host's cancel in order; once they run out, `answer` applies. */
      readonly cancelTries?: readonly (() => Promise<unknown>)[];
      readonly returned?: () => Promise<unknown>;
      /** Sends both commands over a real client and network instead of answering them here. */
      readonly wire?: ReturnType<typeof heldCredentialWire>;
    } = {},
  ) {
    const tries = [...(input.cancelTries ?? [])];
    const cancels = vi.fn(
      async (_command: { attemptId: unknown }) =>
        (await tries.shift()?.()) ?? answered(input.answer ?? "cancelled"),
    );
    const returns = vi.fn(
      async () =>
        (await input.returned?.()) ?? {
          connectionId: null,
          expiresAt,
          failureCode: null,
          status: "completed" as const,
          type: "integration.authorization.return" as const,
        },
    );
    const port = testPort({
      held: true,
      verification: { status: "compatible", capabilities: ["integration-app-finish-v1"] },
      configureClient: (host) => {
        const dispatch = host.dispatch.bind(host);
        (host as { dispatch: SignalledDispatch }).dispatch = async (command, call) => {
          if (
            input.wire &&
            (command.type === "integration.authorization.cancel" ||
              command.type === "integration.authorization.return")
          )
            return input.wire.send(command, call);
          if (command.type === "integration.authorization.cancel") return cancels(command) as never;
          if (command.type === "integration.authorization.return") return returns() as never;
          return dispatch(command);
        };
      },
    });
    let opened!: (url: string) => void;
    const browserOpened = new Promise<string>((resolve) => {
      opened = resolve;
    });
    const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
      // Stays open like a real session, and ends only when its signal says so.
      openIntegrationAuthorization: (url, signal) =>
        new Promise((_, reject) => {
          opened(url);
          signal?.addEventListener("abort", () =>
            reject(new IntegrationAuthorizationCancelledError()),
          );
        }),
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    const controller = new AbortController();
    const started = client.beginIntegrationAuthorization({
      definitionId: "slack",
      signal: controller.signal,
    });
    started.catch(() => undefined);
    const callback = buildNativeIntegrationAuthorizationCallback({
      attemptId: IntegrationOAuthAttemptIdSchema.parse(
        new URL(await browserOpened).pathname.split("/").at(-2),
      ),
      deploymentId: DeploymentIdSchema.parse(serverId),
      returnProof: proof,
    });
    return { callback, cancels, client, controller, returns, started };
  }

  it("tells the Host, ends the browser wait and refuses a late return", async () => {
    const { callback, cancels, client, controller, returns, started } = await signingIn();
    controller.abort();
    await expect(started).rejects.toBeInstanceOf(IntegrationAuthorizationCancelledError);
    expect(cancels).toHaveBeenCalledTimes(1);
    await expect(client.handleIntegrationAuthorizationCallback(callback)).resolves.toBeNull();
    expect(returns).not.toHaveBeenCalled();
    client.dispose();
  });

  // The ways it could fail: `withTimeout` stops only the waiter, so a request held
  // by credential loading still goes out when they arrive. A proof reaching the
  // Host after Cancel can finish a sign-in the person ended.
  describe("a request still waiting for credentials", () => {
    const flushed = () => new Promise((resolve) => setImmediate(resolve));
    const proofs = "integration.authorization.return";
    const cancels = "integration.authorization.cancel";

    it("sends no proof once Cancel has landed", async () => {
      const wire = heldCredentialWire();
      const { callback, client, controller, started } = await signingIn({ wire });
      const release = wire.hold();
      const delivery = client.handleIntegrationAuthorizationCallback(callback);
      await vi.waitFor(() => expect(wire.credentialReads()).toBe(1));
      const proofRequest = wire.lastSignal();
      expect(proofRequest?.aborted).toBe(false);
      controller.abort();
      expect(proofRequest?.aborted).toBe(true);
      await expect(started).rejects.toBeInstanceOf(IntegrationAuthorizationCancelledError);
      release();
      await expect(delivery).resolves.toBeNull();
      await flushed();
      expect(wire.sent(proofs)).toEqual([]);
      expect(wire.sent(cancels)).toHaveLength(1);
      client.dispose();
    });

    it("sends only the retry of a proof whose first try timed out", async () => {
      const wire = heldCredentialWire();
      const { callback, client } = await signingIn({ wire });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const release = wire.hold();
        const delivery = client.handleIntegrationAuthorizationCallback(callback);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(wire.credentialReads()).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        await delivery;
        expect(wire.sent(proofs)).toHaveLength(1);
        release();
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
      await flushed();
      expect(wire.sent(proofs)).toHaveLength(1);
      client.dispose();
    });

    it("sends only the retry of a Cancel whose first try timed out", async () => {
      const wire = heldCredentialWire();
      const { client, controller, started } = await signingIn({ wire });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const release = wire.hold();
        controller.abort();
        await vi.advanceTimersByTimeAsync(10_000);
        const error = await started.catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(IntegrationAuthorizationCancelUnconfirmedError);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(
          (error as IntegrationAuthorizationCancelUnconfirmedError).reconciled,
        ).resolves.toMatchObject({ status: "cancelled" });
        expect(wire.sent(cancels)).toHaveLength(1);
        release();
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        vi.useRealTimers();
      }
      await flushed();
      expect(wire.sent(cancels)).toHaveLength(1);
      client.dispose();
    });
  });

  describe("when the Host does not answer the Cancel", () => {
    const unanswered = () => Promise.reject(new HostTransportError("unreachable"));
    const reconcile = async (started: Promise<unknown>) => {
      const error = await started.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(IntegrationAuthorizationCancelUnconfirmedError);
      return error as IntegrationAuthorizationCancelUnconfirmedError;
    };

    it("says it is unconfirmed, and the completion that won still wins", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { callback, cancels, client, controller, returns, started } = await signingIn({
          answer: "completed",
          cancelTries: [unanswered],
        });
        controller.abort();
        const error = await reconcile(started);
        expect(error.attemptId).toMatch(/^ioa_/u);
        await expect(client.handleIntegrationAuthorizationCallback(callback)).resolves.toBeNull();
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(error.reconciled).resolves.toMatchObject({ status: "completed" });
        expect(cancels).toHaveBeenCalledTimes(2);
        expect(returns).not.toHaveBeenCalled();
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats a request that hangs past its deadline the same way", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { client, controller, started } = await signingIn({
          answer: "completed",
          cancelTries: [() => new Promise(() => {})],
        });
        controller.abort();
        await vi.advanceTimersByTimeAsync(10_000);
        const error = await reconcile(started);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(error.reconciled).resolves.toMatchObject({ status: "completed" });
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports the cancel once the Host confirms it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { client, controller, started } = await signingIn({ cancelTries: [unanswered] });
        controller.abort();
        const error = await reconcile(started);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(error.reconciled).resolves.toMatchObject({ status: "cancelled" });
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps trying until the Host answers, backing off", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { cancels, client, controller, started } = await signingIn({
          answer: "completed",
          cancelTries: [unanswered, unanswered, unanswered],
        });
        controller.abort();
        const error = await reconcile(started);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(cancels).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(cancels).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(4_000);
        await expect(error.reconciled).resolves.toMatchObject({ status: "completed" });
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops claiming anything when the Host refuses the question", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const refused = new HostClientRequestError({
          code: "forbidden",
          message: "Wrong owner",
          status: 403,
        });
        const { client, controller, started } = await signingIn({
          cancelTries: [unanswered, () => Promise.reject(refused)],
        });
        controller.abort();
        const error = await reconcile(started);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(error.reconciled).resolves.toBeNull();
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops asking once the attempt is long past its expiry", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const { client, controller, started } = await signingIn({
          cancelTries: Array.from({ length: 200 }, () => unanswered),
        });
        controller.abort();
        const error = await reconcile(started);
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        await expect(error.reconciled).resolves.toBeNull();
        client.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops when the app is torn down", async () => {
      const { client, controller, started } = await signingIn({
        cancelTries: [unanswered, unanswered],
      });
      controller.abort();
      const error = await reconcile(started);
      client.dispose();
      await expect(error.reconciled).resolves.toBeNull();
    });
  });

  it("reports the completion that won instead of Cancelled", async () => {
    const { client, controller, started } = await signingIn({ answer: "completed" });
    controller.abort();
    await expect(started).resolves.toMatchObject({ status: "completed" });
    client.dispose();
  });

  it("stops an app-link delivery that started first, before its proof goes out", async () => {
    const { callback, cancels, client, controller, returns, started } = await signingIn();
    const load = client.catalog.load.bind(client.catalog);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const catalogRead = vi.spyOn(client.catalog, "load").mockImplementationOnce(async () => {
      await held;
      return load();
    });
    const delivery = client.handleIntegrationAuthorizationCallback(callback);
    await vi.waitFor(() => expect(catalogRead).toHaveBeenCalled());
    controller.abort();
    await expect(started).rejects.toBeInstanceOf(IntegrationAuthorizationCancelledError);
    release();
    await expect(delivery).resolves.toBeNull();
    expect(returns).not.toHaveBeenCalled();
    expect(cancels).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("lets the Host decide when the proof had already gone out", async () => {
    let sent!: () => void;
    const reached = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const { callback, client, controller, started } = await signingIn({
      answer: "completed",
      returned: () => {
        sent();
        return new Promise(() => {});
      },
    });
    const delivery = client.handleIntegrationAuthorizationCallback(callback);
    await withTimeout(reached, 5_000, {
      timeoutError: () => new Error("The proof never reached the Host."),
    });
    controller.abort();
    await expect(started).resolves.toMatchObject({ status: "completed" });
    await expect(delivery).resolves.toBeNull();
    client.dispose();
  });
});

describe("MobileClient startup selection", () => {
  it("distinguishes local hydration from a settled empty selection", async () => {
    const { client } = open(testPort({ held: false }).factory);

    expect(client.getSnapshot().selection).toMatchObject({
      deploymentId: null,
      status: "loading",
    });

    await client.initialize();

    expect(client.getSnapshot().selection).toMatchObject({
      deploymentId: null,
      status: "ready",
    });
    client.dispose();
  });

  it("selects the only locally known deployment once on a new phone", async () => {
    const files = new MemoryPrivateFilesystem();
    const { client } = open(testPort({ held: false }).factory, files);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );

    await client.initialize();

    expect(client.getSnapshot().selection).toMatchObject({
      deploymentId: serverId,
      status: "ready",
    });
    expect(files.text("/private/selection.json")).toContain(serverId);
    client.dispose();
  });

  it("honours an explicit choice to stay on the list even with one deployment", async () => {
    const files = new MemoryPrivateFilesystem();
    files.put(
      "/private/selection.json",
      JSON.stringify({ schemaVersion: 1, selectedDeploymentId: null }),
    );
    const { client } = open(testPort({ held: false }).factory, files);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );

    await client.initialize();

    expect(client.getSnapshot().selection).toMatchObject({
      deploymentId: null,
      status: "ready",
    });
    client.dispose();
  });

  it("publishes a remembered selection without waiting for an offline Host", async () => {
    const files = new MemoryPrivateFilesystem();
    const first = open(testPort({ held: true }).factory, files);
    await first.client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await first.client.initialize();
    await first.client.select(serverId);
    first.client.dispose();

    const verification = deferred<HostEpochAgreement>();
    const started = deferred<void>();
    const base = testPort({ held: true });
    const relaunched = open(
      (options) => ({
        ...base.factory(options),
        verifyEpoch: async () => {
          started.resolve();
          return verification.promise;
        },
      }),
      files,
    );

    await relaunched.client.initialize();
    expect(relaunched.client.getSnapshot().selection).toMatchObject({
      deploymentId: serverId,
      status: "ready",
    });
    await started.promise;
    verification.resolve("unreachable");
    await settle();
    expect(relaunched.client.getSnapshot().selection.deploymentId).toBe(serverId);
    relaunched.client.dispose();
  });

  it("does not hold local startup on an Account directory refresh", async () => {
    const { client } = open(testPort({ held: false }).factory);
    const directory = deferred<"refreshed">();
    vi.spyOn(client.directoryRefresh, "request").mockReturnValue(directory.promise);

    await client.initialize();

    expect(client.getSnapshot().selection.status).toBe("ready");
    directory.resolve("refreshed");
    client.dispose();
  });

  it("auto-selects and connects the only Connect deployment when the Account directory arrives", async () => {
    const { client, opened } = open(
      testPort({ held: false, realCredentials: true }).factory,
      new MemoryPrivateFilesystem(),
      {
        accountOrigin,
        fetch: accountFetch(),
      },
    );
    const establish = vi
      .spyOn(client.sessionExchange, "establish")
      .mockResolvedValue(sessionExchangeResponse());
    vi.spyOn(client.accountDirectory, "sync").mockImplementation(async () => {
      await client.catalog.upsert(connectComputer(1));
      return { syncedDeploymentIds: [DeploymentIdSchema.parse(serverId)], unavailable: [] };
    });
    await client.initialize();

    await signInTestAccount(client, opened);
    await settle();

    expect(client.getSnapshot().selection).toMatchObject({
      deploymentId: serverId,
      status: "ready",
    });
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    expect(establish).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});

describe("MobileClient Account directory state", () => {
  it("clears a removed Account selection without switching to another deployment", async () => {
    const port = testPort({ held: false });
    const invalidated: string[] = [];
    const { client } = open(port.factory, undefined, {
      savedViewStore: {
        load: async () => null,
        write: async () => undefined,
        invalidate: async (id) => {
          invalidated.push(id);
        },
      },
    });
    await client.catalog.upsertAndSelect(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: serverId,
          source: { issuer: accountOrigin, kind: "account", subject: accountSubject },
        }),
      ),
    );
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: otherId,
          name: "manual server",
        }),
      ),
    );
    await client.initialize();
    await client.select(serverId);

    await client.clearAccountSavedViews();
    // Push unregistration still needs the Account credential; keys leave first.
    expect(invalidated).toContain(serverId);
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    await client.signOutAccount();
    await settle();

    expect(client.getSnapshot().catalog.deployments).toHaveLength(1);
    expect(client.getSnapshot().selection).toMatchObject({
      connection: null,
      deploymentId: null,
      hostClient: null,
      status: "ready",
    });
    expect(new Set(invalidated)).toEqual(new Set([serverId]));
    expect(invalidated).not.toContain(otherId);
    client.dispose();
  });

  it("does not report Account sign-in complete while authorization is still pending", async () => {
    const port = testPort({ held: false });
    const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
      accountOrigin,
      fetch: accountFetch(),
    });
    await client.initialize();

    await expect(client.signInAccount()).rejects.toThrow(/authorization in your browser/u);
    await settle();
    expect(client.getSnapshot().account.account.status).toBe("authorizing");
    client.dispose();
  });

  it("distinguishes a verified empty directory from one that has not loaded", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory, new MemoryPrivateFilesystem(), {
      accountOrigin,
      fetch: accountFetch(),
    });
    const pending = deferred<{
      readonly syncedDeploymentIds: readonly never[];
      readonly unavailable: readonly never[];
    }>();
    vi.spyOn(client.accountDirectory, "sync").mockImplementation(() => pending.promise);
    await client.initialize();

    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "idle",
      unavailable: [],
    });
    await signInTestAccount(client, opened);
    await settle();
    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "loading",
      unavailable: [],
    });

    pending.resolve({ syncedDeploymentIds: [], unavailable: [] });
    await settle();
    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "ready",
      unavailable: [],
    });
    client.dispose();
  });

  it("publishes refresh failures and clears them after a successful retry", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory, new MemoryPrivateFilesystem(), {
      accountOrigin,
      fetch: accountFetch(),
    });
    const sync = vi
      .spyOn(client.accountDirectory, "sync")
      .mockRejectedValueOnce(new Error("The Account directory did not answer."))
      .mockResolvedValue({ syncedDeploymentIds: [], unavailable: [] });
    await client.initialize();
    await signInTestAccount(client, opened);
    await settle();

    expect(client.getSnapshot().directory).toEqual({
      detail: "The Account directory did not answer.",
      status: "error",
      unavailable: [],
    });
    await client.refreshDirectory();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "ready",
      unavailable: [],
    });
    client.dispose();
  });

  it("retains directory entries that failed verification in the ready result", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory, new MemoryPrivateFilesystem(), {
      accountOrigin,
      fetch: accountFetch(),
    });
    const unavailable = [
      {
        accountAccess: "owner" as const,
        deploymentId: DeploymentIdSchema.parse(serverId),
        name: "Unavailable Host",
        reason: "host-unavailable" as const,
      },
    ];
    vi.spyOn(client.accountDirectory, "sync").mockResolvedValue({
      syncedDeploymentIds: [],
      unavailable,
    });
    await client.initialize();
    await signInTestAccount(client, opened);
    await settle();

    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "ready",
      unavailable,
    });
    client.dispose();
  });

  it("does not publish a prior Account's late directory result after sign-out", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory, new MemoryPrivateFilesystem(), {
      accountOrigin,
      fetch: accountFetch(),
    });
    const pending = deferred<{
      readonly syncedDeploymentIds: readonly never[];
      readonly unavailable: readonly {
        readonly accountAccess: "owner";
        readonly deploymentId: ReturnType<typeof DeploymentIdSchema.parse>;
        readonly name: string;
        readonly reason: "host-unavailable";
      }[];
    }>();
    vi.spyOn(client.accountDirectory, "sync").mockImplementation(() => pending.promise);
    await client.initialize();
    await signInTestAccount(client, opened);
    await settle();
    expect(client.getSnapshot().directory.status).toBe("loading");

    await client.signOutAccount();
    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "idle",
      unavailable: [],
    });
    pending.resolve({
      syncedDeploymentIds: [],
      unavailable: [
        {
          accountAccess: "owner",
          deploymentId: DeploymentIdSchema.parse(serverId),
          name: "Prior Account Host",
          reason: "host-unavailable",
        },
      ],
    });
    await settle();

    expect(client.getSnapshot().account.account.status).toBe("signed-out");
    expect(client.getSnapshot().directory).toEqual({
      detail: null,
      status: "idle",
      unavailable: [],
    });
    client.dispose();
  });
});

describe("MobileClient attachment reconciliation", () => {
  it("re-reads capability evidence for a retained route and fences retired readers", async () => {
    const options: { held: boolean; verification: HostEpochAgreement } = {
      held: true,
      verification: { status: "compatible", capabilities: ["browser-target-control-v1"] },
    };
    const port = testPort(options);
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    const read = port.capabilityReaders.at(-1);
    expect(typeof read).toBe("function");
    if (typeof read !== "function") throw new Error("Attachment requires a capability reader");
    expect(await read()).toEqual(["browser-target-control-v1"]);
    options.verification = {
      status: "compatible",
      capabilities: ["browser-target-control-v1", "browser-capture-region-v1"],
    };
    expect(await read({ revalidate: true })).toEqual(options.verification.capabilities);
    expect(port.attached).toHaveLength(1);
    options.verification = "identity-mismatch";
    await expect(read({ revalidate: true })).rejects.toThrow();
    options.verification = { status: "compatible", capabilities: [] };
    client.dispose();
    await expect(read()).rejects.toThrow();
  });

  it("reuses deferred discovery for bootstrap and polling, but not a new attachment", async () => {
    const port = testPort({ held: true });
    const probe = deferred<HostEpochAgreement>();
    const started = deferred<void>();
    const verify = vi.fn(async () => {
      started.resolve();
      return probe.promise;
    });
    const { client } = open((options) => ({ ...port.factory(options), verifyEpoch: verify }));
    try {
      await client.catalog.upsertAndSelect(connectComputer(1));
      await client.initialize();
      const selecting = client.select(serverId);
      await started.promise;
      expect(port.attached).toHaveLength(0);
      probe.resolve({ status: "compatible", capabilities: ["thread-titles-v1"] });
      await selecting;
      const read = port.capabilityReaders.at(-1);
      if (typeof read !== "function") throw new Error("Expected capability reader");
      // The initial bootstrap and periodic bootstraps ask the same attachment.
      expect(await read()).toEqual(["thread-titles-v1"]);
      expect(await read()).toEqual(["thread-titles-v1"]);
      expect(verify).toHaveBeenCalledTimes(1);
      await client.retrySelection();
      expect(verify).toHaveBeenCalledTimes(2);
      await expect(read()).rejects.toThrow(/attachment changed/u);
    } finally {
      client.dispose();
    }
  });

  it("rejects a discovery refresh completed after its attachment generation changed", async () => {
    const port = testPort({ held: true });
    const probe = deferred<HostEpochAgreement>();
    const { client } = open((options) => ({
      ...port.factory(options),
      verifyEpoch: vi
        .fn()
        .mockResolvedValueOnce({ status: "compatible", capabilities: [] })
        .mockImplementationOnce(() => probe.promise)
        .mockResolvedValue({ status: "compatible", capabilities: [] }),
    }));
    try {
      await client.catalog.upsertAndSelect(connectComputer(1));
      await client.initialize();
      await client.select(serverId);
      const read = port.capabilityReaders.at(-1);
      if (typeof read !== "function") throw new Error("Expected capability reader");
      const reading = read({ revalidate: true });
      const rejected = expect(reading).rejects.toThrow();
      await client.catalog.upsertAndSelect(connectComputer(2));
      await client.reconcile();
      probe.resolve("identity-mismatch");
      await rejected;
      expect(client.getSnapshot().selection.row?.verification).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("does not replace a settled attachment when its row is selected again", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    const attached = port.attached.length;

    await client.select(serverId);

    expect(port.attached).toHaveLength(attached);
    expect(port.disposed).toEqual([]);
    client.dispose();
  });

  it("does not replace a connected attachment when its deployment is opened again", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    await settle();
    const attached = port.attached.length;

    await client.openDeployment(serverId);

    expect(port.attached).toHaveLength(attached);
    expect(port.disposed).toEqual([]);
    client.dispose();
  });

  it("publishes and attaches a newer selection without waiting for the prior Host probe", async () => {
    const port = testPort({ held: true });
    const firstProbe = deferred<HostEpochAgreement>();
    const firstProbeStarted = deferred<void>();
    const { client } = open((options) => ({
      ...port.factory(options),
      verifyEpoch: async (resolved) => {
        if (resolved.deploymentId !== serverId) return { status: "compatible", capabilities: [] };
        firstProbeStarted.resolve();
        return firstProbe.promise;
      },
    }));
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "available" }),
      ),
    );
    await client.initialize();

    let firstSettled = false;
    const first = client.select(serverId);
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await firstProbeStarted.promise;

    await client.select(otherId);

    expect(firstSettled).toBe(false);
    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(port.attached.map(({ deploymentId }) => deploymentId)).toEqual([otherId]);

    firstProbe.resolve("unreachable");
    await first;
    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(port.attached.map(({ deploymentId }) => deploymentId)).toEqual([otherId]);
    client.dispose();
  });

  it("retries an offline selected deployment only when explicitly asked", async () => {
    const options: { held: boolean; verification: HostEpochAgreement } = {
      held: true,
      verification: "unreachable",
    };
    const port = testPort(options);
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    expect(client.getSnapshot().selection.row?.status).toBe("offline");
    const verified = port.verified.length;

    await client.select(serverId);
    expect(port.verified).toHaveLength(verified);

    options.verification = { status: "compatible", capabilities: [] };
    await client.retrySelection();
    expect(port.attached).toHaveLength(1);
    client.dispose();
  });

  it("adopts a deployment deliberately selected by an add flow", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);

    await client.catalog.upsertAndSelect(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "new server" }),
      ),
    );
    await client.reconcile();
    await settle();

    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(port.attached.at(-1)?.deploymentId).toBe(otherId);
    client.dispose();
  });

  it("rejects a stale deep-link selection without dropping the current one", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    const attachment = client.getSnapshot().selection.hostClient;

    await expect(client.select(otherId)).rejects.toThrow(/no longer in this app's list/u);

    expect(client.getSnapshot().selection.deploymentId).toBe(serverId);
    expect(client.getSnapshot().selection.hostClient).toBe(attachment);
    client.dispose();
  });

  it("keeps the current attachment when the new selection cannot be saved", async () => {
    const port = testPort({ held: true });
    const storage = failingSelectionWrites(new MemoryPrivateFilesystem());
    const { client } = open(port.factory, storage.filesystem);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "elsewhere" }),
      ),
    );
    await client.initialize();
    await client.select(serverId);
    const attachment = client.getSnapshot().selection.hostClient;
    storage.failNext();

    await expect(client.select(otherId)).rejects.toThrow(/storage did not answer/u);

    expect(client.getSnapshot().selection.deploymentId).toBe(serverId);
    expect(client.getSnapshot().selection.hostClient).toBe(attachment);
    expect((await client.catalog.load()).selectedDeploymentId).toBe(serverId);
    client.dispose();
  });

  it("replaces the client when the route it captured rotates", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);

    expect(port.attached).toHaveLength(1);
    expect(port.disposed).toEqual([]);

    // The same computer on a newly signed route: same Host, different
    // generation, so every socket the old client holds is on a path that no
    // longer exists.
    await client.catalog.upsertAndSelect(connectComputer(2));
    await settle();

    expect(port.disposed).toEqual([serverId]);
    expect(port.attached).toHaveLength(2);
    expect(client.getSnapshot().selection.hostClient).not.toBeNull();
    client.dispose();
  });

  it("keeps the client it has when the catalog changes around it", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);

    // A row arriving from the Account directory, which never moves the
    // selection: the attachment has no reason to notice it.
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "elsewhere" }),
      ),
    );
    await settle();

    expect(port.disposed).toEqual([]);
    expect(port.attached).toHaveLength(1);
    client.dispose();
  });

  it("returns to the deployment list when the selected row is removed", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const files = new MemoryPrivateFilesystem();
    const { client } = open(port.factory, files);
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "remaining" }),
      ),
    );
    await client.initialize();
    await client.select(serverId);

    await client.remove(serverId);
    await settle();

    expect(client.getSnapshot().catalog.deployments).toHaveLength(1);
    expect(client.getSnapshot().selection).toMatchObject({
      connection: null,
      deploymentId: null,
      hostClient: null,
      status: "ready",
    });
    expect(files.text("/private/selection.json")).not.toContain(otherId);
    client.dispose();
  });

  it("clears the selection when the attached Deployment leaves the list", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);

    await client.catalog.remove(serverId);
    await settle();

    expect(port.disposed).toEqual([serverId]);
    expect(client.getSnapshot().selection.deploymentId).toBeNull();
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    client.dispose();
  });

  it("forgets a remembered selection that no longer resolves instead of failing to start", async () => {
    const port = testPort({ held: true });
    const first = open(port.factory);
    await first.client.catalog.upsertAndSelect(connectComputer(1));
    await first.client.initialize();
    await first.client.select(serverId);
    first.client.dispose();

    // The Account dropped it while this phone was closed.
    const relaunched = open(testPort({ held: true }).factory, first.privateFiles);
    await relaunched.client.catalog.remove(serverId);
    await expect(relaunched.client.initialize()).resolves.toBeUndefined();

    expect(relaunched.client.getSnapshot().selection.deploymentId).toBeNull();
    relaunched.client.dispose();
  });
});

describe("MobileClient cold saved launch", () => {
  it("resumes capture when deletion finishes after the same Deployment reattaches", async () => {
    const encrypted = savedViewFixture(savedViewCleanup),
      store = encrypted.open();
    const write = vi.spyOn(store, "write"),
      started = deferred<void>(),
      release = deferred<void>();
    const invalidate = store.invalidate.bind(store);
    let delayed = false;
    vi.spyOn(store, "invalidate").mockImplementation(async (id) => {
      if (delayed) {
        started.resolve();
        await release.promise;
      }
      await invalidate(id);
    });
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory, undefined, { savedViewStore: store });
    await client.initialize();
    await client.catalog.upsert(connectComputer(1));
    await client.sessions.save(personalSession());
    await client.select(serverId);
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
    await settle();
    await client.savedViews.flush();
    expect(write).toHaveBeenCalled();
    write.mockClear();
    delayed = true;
    const changing = client.sessions.save(personalSession());
    await started.promise;
    await client.retrySelection();
    await settle();
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    await client.savedViews.flush();
    expect(write).not.toHaveBeenCalled();
    release.resolve();
    await changing;
    await vi.waitFor(async () => {
      await client.savedViews.flush();
      expect(write).toHaveBeenCalled();
    });
    expect(client.getSnapshot().savedViewFailure).toBeNull();
    expect(client.savedViews.getSnapshot().tasks.source).not.toBe("saved");
    client.dispose();
  });

  it.each(["pairing", "connect"] as const)(
    "erases the old key and replaces the live owner when %s replaces a Personal login",
    async (door) => {
      const encrypted = savedViewFixture(savedViewCleanup),
        store = encrypted.open();
      const write = vi.spyOn(store, "write");
      const port = testPort({
        held: false,
        realCredentials: true,
        configureClient: (host) => {
          const read = host.getSnapshot.bind(host),
            userId = createId("user");
          vi.spyOn(host, "getSnapshot").mockImplementation(() => {
            const snapshot = read();
            return { ...snapshot, user: snapshot.user ? { ...snapshot.user, id: userId } : null };
          });
        },
      });
      const { client } = open(port.factory, undefined, { savedViewStore: store });
      const connection = testDeploymentConnection({
        deploymentId: serverId,
        kind: "personal",
        route: { kind: door === "pairing" ? "private" : "connect" },
      });
      if (connection.reachability !== "routed" || !connection.personalAccessRoute)
        throw new Error("Expected a verified Personal access route");
      const accessRoute = connection.personalAccessRoute;
      await client.initialize();
      const establish = vi.fn(async () => sessionExchangeResponse());
      vi.spyOn(client.sessionExchange, "establish").mockImplementation(establish);
      const replace = async () => {
        if (door === "connect") {
          await client.signIn(serverId);
          return;
        }
        await addPersonalDeployment({
          catalog: client.catalog,
          sessions: client.sessions,
          exchange: { establish },
          name: connection.name,
          pairingCode: "123456",
          verified: {
            bootstrapMethods: connection.bootstrapMethods,
            capabilities: [],
            discovery: connection.authority.document,
            discoveryEnvelope: connection.authority,
            endpoint: connection.endpoints[0]!,
            accessRoute,
          },
        });
        await client.reconcile();
      };
      if (door === "connect") {
        await client.catalog.upsert(asInput(connection));
        await settle();
      }
      await replace();
      await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
      await settle();
      await client.savedViews.flush();
      const before = write.mock.calls.at(-1)![0],
        first = client.getSnapshot().selection.hostClient;
      expect(await store.load(before, () => true)).toEqual(before);
      await replace();
      await vi.waitFor(() => expect(client.getSnapshot().selection.hostClient).not.toBe(first));
      await settle();
      expect(port.disposed).toContain(serverId);
      expect(encrypted.slots()).toEqual([]);
      expect(
        (await client.sessions.load(DeploymentIdSchema.parse(serverId)))!.viewLoginId,
      ).not.toBe(before.loginId);
      expect(await store.load(before, () => true)).toBeNull();
      expect(client.savedViews.getSnapshot().tasks.source).not.toBe("saved");
      await client.savedViews.flush();
      const after = write.mock.calls.at(-1)![0];
      expect(after.loginId).not.toBe(before.loginId);
      expect(after.userId).not.toBe(before.userId);
      expect(await store.load(after, () => true)).toEqual(after);
      client.dispose();
    },
  );
  it("hides and erases Account A's saved view before Account B's consent", async () => {
    const encrypted = savedViewFixture(savedViewCleanup),
      store = encrypted.open();
    const write = vi.spyOn(store, "write");
    let subject = accountSubject;
    const account = accountFetch(() => subject);
    const port = testPort({ held: false, realCredentials: true });
    const { client, opened } = open(port.factory, undefined, {
      savedViewStore: store,
      accountOrigin,
      fetch: (input, init) =>
        String(input).startsWith(accountOrigin) ? account(input, init) : testFetch(input),
    });
    vi.spyOn(client.accountDirectory, "sync").mockResolvedValue({
      syncedDeploymentIds: [],
      unavailable: [],
    });
    await client.initialize();
    await signInTestAccount(client, opened);
    const accountConnection = () =>
      testDeploymentConnection({
        kind: "personal",
        deploymentId: serverId,
        source: { kind: "account", issuer: accountOrigin, subject },
      });
    await client.catalog.upsert(asInput(accountConnection()));
    await client.select(serverId);
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
    await settle();
    await client.savedViews.flush();
    const before = write.mock.calls.at(-1)![0],
      hostLogin = (await client.sessions.load(DeploymentIdSchema.parse(serverId)))?.viewLoginId;
    expect(before.accountSource?.subject).toBe(accountSubject);
    expect(await store.load(before, () => true)).toEqual(before);
    const signing = client.oauth.beginAccountSignIn();
    expect(client.savedViews.getSnapshot().tasks.source).toBe("blocked");
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    await signing;
    expect(encrypted.slots()).toEqual([]);
    expect((await client.sessions.load(DeploymentIdSchema.parse(serverId)))?.viewLoginId).toBe(
      hostLogin,
    );
    subject = ControlPlaneAccountIdSchema.parse("acct_0192f4a1-8888-4000-8000-000000000008");
    const callback = new URL(opensteerMobileAccountOAuthCallback);
    callback.searchParams.set("code", "account-code");
    callback.searchParams.set("iss", accountOrigin);
    callback.searchParams.set("state", new URL(opened.at(-1)!).searchParams.get("state")!);
    await client.oauth.handleCallback(callback.toString());
    await settle();
    expect(client.oauth.accountIdentity()?.subject).toBe(subject);
    expect(await store.load(before, () => true)).toBeNull();
    await client.catalog.upsert(asInput(accountConnection()));
    await client.select(serverId);
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
    await settle();
    await client.savedViews.flush();
    const after = write.mock.calls.at(-1)![0];
    expect(after.loginId).not.toBe(before.loginId);
    expect(after.accountSource?.subject).toBe(subject);
    expect(after.accountSource?.loginId).not.toBe(before.accountSource?.loginId);
    expect(await store.load(after, () => true)).toEqual(after);
    client.dispose();
  });

  it.each(["authentication", "marker-write"] as const)(
    "keeps refused encrypted content denied across owner restart after %s failure",
    async (reason) => {
      const encrypted = savedViewFixture(savedViewCleanup),
        files = new MemoryPrivateFilesystem();
      const records = createSecureRecordStore({
        keyPrefix: "restart",
        secureStore: new MemorySecureStore(),
      });
      const store = encrypted.open(),
        write = vi.spyOn(store, "write");
      const port = testPort({ held: false, realCredentials: true });
      const { client } = open(port.factory, files, { records, savedViewStore: store });
      await client.initialize();
      await client.catalog.upsert(connectComputer(1));
      await client.sessions.save(personalSession());
      await client.select(serverId);
      await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
      await settle();
      await client.savedViews.flush();
      const saved = write.mock.calls.at(-1)![0];
      expect(await store.load(saved, () => true)).toEqual(saved);
      const credential = await records.read(`personal.${serverId}`);
      let deletionAttempts = 0;
      encrypted.keys.interrupt = (step) => {
        // Key-slot deletions; the ownership index beside them is bookkeeping.
        if (step.startsWith("delete:") && step !== "delete:saved.owners") {
          deletionAttempts += 1;
          if (reason !== "marker-write") throw new Error("locked");
        }
      };
      const markerWrite =
        reason === "marker-write"
          ? vi.spyOn(files, "writeFileExclusive").mockRejectedValue(new Error("disk full"))
          : null;
      port.refusals.at(-1)!();
      expect(client.savedViews.getSnapshot().tasks.source).toBe("blocked");
      await vi.waitFor(() =>
        expect(client.getSnapshot().savedViewFailure).toMatch(/cleanup could not be completed/u),
      );
      await client.savedViews.flush();
      expect(await records.read(`personal.${serverId}`)).toBe(credential);
      const marker = `/private/saved-view-denials/${serverId}.deny`;
      if (markerWrite) {
        expect(deletionAttempts).toBe(1);
        expect(encrypted.slots()).toEqual([]);
        expect(files.text(marker)).toBeNull();
      } else {
        expect(files.text(marker)).toBe("");
      }
      // Restart immediately, before marker repair or any foreground retry.
      const beforeRestart = deletionAttempts;
      client.dispose();
      const offline = testPort({ held: false, realCredentials: true, verification: "unreachable" });
      const restarted = open(offline.factory, files, {
        records,
        savedViewStore: encrypted.open(),
      }).client;
      const frames: string[] = [];
      restarted.savedViews.subscribe(() =>
        frames.push(restarted.savedViews.getSnapshot().tasks.source),
      );
      await restarted.initialize();
      await settle();
      expect(restarted.savedViews.getSnapshot().tasks.source).not.toBe("saved");
      expect(frames).not.toContain("saved");
      if (markerWrite) {
        expect(deletionAttempts).toBe(beforeRestart);
        expect(encrypted.slots()).toEqual([]);
      } else {
        expect(deletionAttempts).toBeGreaterThan(beforeRestart);
        expect(encrypted.slots()).toHaveLength(1);
      }
      markerWrite?.mockRestore();
      encrypted.keys.interrupt = () => {};
      await restarted.foregrounded();
      expect(encrypted.slots()).toEqual([]);
      expect(restarted.getSnapshot().savedViewFailure).toBeNull();
      expect(await records.read(`personal.${serverId}`)).toBe(credential);
      expect(await encrypted.open().load(saved, () => true)).toBeNull();
      restarted.dispose();
    },
  );

  it("shows the remembered saved surfaces while normal attachment bootstrap is deferred", async () => {
    const store = createMemorySavedViews(),
      records = createSecureRecordStore({
        keyPrefix: "test",
        secureStore: new MemorySecureStore(),
      }),
      files = new MemoryPrivateFilesystem();
    const firstPort = testPort({ held: true, realCredentials: true });
    const { client: first } = open(firstPort.factory, files, {
      records,
      savedViewStore: store,
    });
    await first.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await first.initialize();
    await first.sessions.save(personalSession());
    await first.retrySelection();
    await settle();
    await first.savedViews.flush();
    const load = vi.spyOn(store, "load");
    first.dispose();
    const bootstrap = deferred<void>();
    let ready = false;
    const port = testPort({
      held: true,
      realCredentials: true,
      configureClient: (host) => {
        const read = host.getSnapshot.bind(host),
          load = host.load.bind(host);
        vi.spyOn(host, "getSnapshot").mockImplementation(() =>
          ready
            ? read()
            : {
                ...read(),
                user: null,
                session: "checking",
                savedViewReadiness: {
                  tasksReady: false,
                },
              },
        );
        host.load = async () => {
          await bootstrap.promise;
          ready = true;
          await load();
        };
      },
    });
    const { client } = open(port.factory, files, { records, savedViewStore: store });
    await client.initialize();
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("saved"));
    expect(client.getSnapshot().selection).toMatchObject({
      deploymentId: serverId,
      status: "ready",
    });
    expect(client.savedViews.getSnapshot().tasks).toMatchObject({
      source: "saved",
      label: "Updating…",
    });
    expect(load).toHaveBeenCalled();
    expect(port.attached).toHaveLength(1);
    const capabilities = port.capabilityReaders[0];
    if (typeof capabilities !== "function") throw new Error("Expected capability reader");
    expect(await capabilities()).toEqual([]);
    expect(port.verified).toHaveLength(1);
    bootstrap.resolve();
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
    await client.savedViews.flush();
    expect(await capabilities()).toEqual([]);
    expect(port.verified).toHaveLength(1);
    client.dispose();
  });
  it("does not revive old presentation or capture when local scope initialization crosses personal sign-out", async () => {
    const base = testPort({ held: true }),
      gate = deferred<void>(),
      loginId = globalThis.crypto.randomUUID(),
      writes = vi.fn();
    let calls = 0;
    const port: MobileHostPortFactory = (input) => {
      const value = base.factory(input);
      return {
        ...value,
        credentials: {
          ...value.credentials,
          viewLoginId: async () => {
            calls += 1;
            if (calls !== 2) await gate.promise;
            return loginId;
          },
        },
      };
    };
    const { client } = open(port, undefined, {
      savedViewStore: {
        load: async () => null,
        write: async (view) => {
          writes(view);
        },
        invalidate: async () => undefined,
      },
    });
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await vi.waitFor(() => expect(client.getSnapshot().selection.row?.status).toBe("connected"));
    const changing = client.signOut(serverId);
    gate.resolve();
    await changing;
    await settle();
    expect(client.savedViews.getSnapshot().tasks.source).toBe("blocked");
    await client.savedViews.flush();
    expect(writes).not.toHaveBeenCalled();
    client.dispose();
  });

  it("uses the same controller with synthetic login IDs and memory-only storage in mock mode", async () => {
    const memory = createMemorySavedViews(),
      write = vi.spyOn(memory, "write"),
      secure = new MemorySecureStore();
    const { client } = open(createMockHostPort(), undefined, {
      savedViewStore: memory,
      records: createSecureRecordStore({ keyPrefix: "mock-auth", secureStore: secure }),
    });
    const connection = mockDeploymentConnections()[0]!;
    expect(connection.authority.document).not.toHaveProperty("deploymentPolicy");
    await client.catalog.upsertAndSelect(connection);
    await client.initialize();
    await client.select(connection.authority.document.deploymentId);
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
    await client.savedViews.flush();
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls.at(-1)?.[0]).toMatchObject({
      loginId: expect.any(String),
      tasks: expect.any(Array),
    });
    expect(secure.keys).toEqual([]);
    write.mockClear();
    await client.signOutAccount();
    await client.savedViews.flush();
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls.at(-1)?.[1]()).toBe(true);
    client.dispose();
  });
});

describe("MobileClient sign-in", () => {
  it("attaches a Personal session when optional saved-view identity storage fails", async () => {
    const base = testPort({ held: false, realCredentials: true }),
      store = createMemorySavedViews();
    const load = vi.spyOn(store, "load"),
      write = vi.spyOn(store, "write");
    const { client } = open(base.factory, undefined, { savedViewStore: store });
    await client.initialize();
    await client.catalog.upsert(connectComputer(1));
    await client.sessions.save(personalSession());
    const metadataRead = vi
      .spyOn(client.sessions, "load")
      .mockRejectedValue(new Error("Keychain locked"));
    await expect(client.select(serverId)).resolves.toBeUndefined();
    await settle();
    expect(metadataRead).toHaveBeenCalled();
    expect(base.attached).toHaveLength(1);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    await client.savedViews.flush();
    expect(client.savedViews.getSnapshot().tasks.source).not.toBe("saved");
    expect(load).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    client.dispose();
  });

  it("keeps the selected computer attached while a team signs in or cancels sign-in", async () => {
    const port = testPort({ held: true });
    const deleted: string[] = [];
    const { client, opened } = open(port.factory, undefined, {
      savedViewStore: {
        load: async () => null,
        write: async () => undefined,
        invalidate: async (id) => {
          deleted.push(id);
        },
      },
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: otherId })),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(otherId);
    const computer = client.getSnapshot().selection.hostClient;
    const signIn = async () => {
      await client.signIn(serverId);
      const state = new URL(opened.at(-1)!).searchParams.get("state")!;
      await client.oauth.handleCallback(
        `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
      );
      await settle();
    };
    await signIn();
    const team = client.getSnapshot().teams[0]!.connection;
    expect(client.oauth.hostCredentialState(team).status).toBe("signed-in");
    const login = client.oauth.hostViewLoginId(team);
    await client.signIn(serverId);
    client.oauth.abandonHostSignIn(DeploymentIdSchema.parse(serverId));
    await settle();
    expect(client.oauth.hostViewLoginId(team)).toBe(login);
    expect(client.getSnapshot().selection.hostClient).toBe(computer);
    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(deleted).toContain(serverId);
    expect(deleted).not.toContain(otherId);
    expect(port.disposed).toEqual([]);
    client.dispose();
  });

  it("clears a team's cached authority before revocation and retries a failed cleanup", async () => {
    const port = testPort({ held: true });
    const events: string[] = [];
    let fail = false;
    const { client, opened } = open(port.factory, undefined, {
      savedViewStore: {
        load: async () => null,
        write: async () => undefined,
        invalidate: async () => {
          events.push("delete-key");
          if (fail) throw new Error("locked");
        },
      },
      fetch: async (input) => {
        if (String(input).includes("/revoke")) events.push("revoke");
        return testFetch(input);
      },
    });
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
    );
    await client.initialize();
    await client.signIn(serverId);
    const state = new URL(opened.at(-1)!).searchParams.get("state")!;
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await settle();
    events.length = 0;
    fail = true;
    await client.signOut(serverId);
    expect(events[0]).toBe("delete-key");
    expect(events).toContain("revoke");
    expect(client.getSnapshot().savedViewFailure).toMatch(/cleanup could not be completed/u);
    expect(port.attached).toEqual([]);
    fail = false;
    await client.foregrounded();
    expect(client.getSnapshot().savedViewFailure).toBeNull();
    client.dispose();
  });

  it("establishes a missing Connect session while selecting and lands connected", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(connectComputer(1));
    const establish = vi
      .spyOn(client.sessionExchange, "establish")
      .mockResolvedValue(sessionExchangeResponse());

    await client.select(serverId);
    await settle();

    expect(establish).toHaveBeenCalledTimes(1);
    expect(port.attached).toEqual([
      { deploymentId: serverId, origin: "https://route.example.com" },
    ]);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    client.dispose();
  });

  it("discards a Connect exchange that finishes after another deployment is selected", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(connectComputer(1));
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "elsewhere" }),
      ),
    );
    const exchange = deferred<ReturnType<typeof sessionExchangeResponse>>();
    const started = deferred<void>();
    vi.spyOn(client.sessionExchange, "establish").mockImplementation(async () => {
      started.resolve();
      return exchange.promise;
    });

    const first = client.select(serverId);
    await started.promise;
    await client.select(otherId);
    exchange.resolve(sessionExchangeResponse());
    await first;

    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(await client.sessions.load(DeploymentIdSchema.parse(serverId))).toBeNull();
    expect(port.attached).toEqual([]);
    client.dispose();
  });

  it("refuses to select or open a team as a computer before and after sign-in", async () => {
    const port = testPort({ held: true });
    const { client, opened, privateFiles } = open(port.factory);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: otherId })),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(otherId);
    const computer = client.getSnapshot().selection.hostClient;
    for (const action of ["select", "openDeployment"] as const) {
      await expect(client[action](serverId)).rejects.toThrow(
        /team cannot be opened as a computer/u,
      );
    }
    expect(opened).toEqual([]);
    await client.signIn(serverId);
    const state = new URL(opened.at(-1)!).searchParams.get("state")!;
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await settle();
    for (const action of ["select", "openDeployment"] as const) {
      await expect(client[action](serverId)).rejects.toThrow(
        /team cannot be opened as a computer/u,
      );
    }
    expect(client.getSnapshot().selection.hostClient).toBe(computer);
    expect(client.getSnapshot().rows.map(({ deploymentId }) => deploymentId)).toEqual([otherId]);
    expect(await client.catalog.load()).toMatchObject({ selectedDeploymentId: otherId });
    expect(
      new TextDecoder().decode((await privateFiles.readFile("/private/selection.json", 1024))!),
    ).toContain(otherId);
    expect(port.attached.every(({ deploymentId }) => deploymentId === otherId)).toBe(true);
    client.dispose();
  });

  it("leaves a team-only catalog unselected on a fresh phone or stale remembered selection", async () => {
    for (const remembered of [false, true]) {
      const port = testPort({ held: true });
      const files = new MemoryPrivateFilesystem();
      if (remembered)
        await files.writeFileAtomic(
          "/private/selection.json",
          JSON.stringify({ schemaVersion: 1, selectedDeploymentId: serverId }),
        );
      const { client, opened } = open(port.factory, files);
      await client.catalog.upsertAndSelect(
        asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
      );
      await client.initialize();
      await settle();
      expect(client.getSnapshot().selection.deploymentId).toBeNull();
      expect(client.getSnapshot().rows).toEqual([]);
      expect(client.getSnapshot().teams).toHaveLength(1);
      expect(port.attached).toEqual([]);
      expect(opened).toEqual([]);
      client.dispose();
    }
  });

  it("does not open Host OAuth when opening discovers an identity mismatch", async () => {
    const port = testPort({ held: false, verification: "identity-mismatch" });
    const { client, opened } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await settle();

    await client.openDeployment(serverId);

    expect(opened).toEqual([]);
    expect(client.getSnapshot().selection.row).toMatchObject({
      status: "unverified",
      verification: "identity-mismatch",
    });
    await expect(client.signIn(serverId)).rejects.toThrow(/different deployment/u);
    expect(opened).toEqual([]);
    client.dispose();
  });

  it("does not open Host OAuth when another selection wins during verification", async () => {
    const port = testPort({ held: false });
    const verification = deferred<HostEpochAgreement>();
    const started = deferred<void>();
    const { client, opened } = open((options) => ({
      ...port.factory(options),
      verifyEpoch: async (resolved) => {
        if (resolved.deploymentId !== serverId) return { status: "compatible", capabilities: [] };
        started.resolve();
        return verification.promise;
      },
    }));
    await client.initialize();
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "newer choice" }),
      ),
    );

    const opening = client.openDeployment(serverId);
    await started.promise;
    await client.select(otherId);
    verification.resolve({ status: "compatible", capabilities: [] });
    await opening;

    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(opened).toEqual([]);
    client.dispose();
  });

  it.each<{
    readonly door: "account-grant" | "pairing-code" | null;
    readonly outcome: HostSessionExchangeFailure;
    readonly status: "needs-sign-in" | "offline";
  }>([
    { door: "account-grant", outcome: "account-required", status: "needs-sign-in" },
    { door: "pairing-code", outcome: "pairing-required", status: "needs-sign-in" },
    { door: "account-grant", outcome: "blocked", status: "needs-sign-in" },
    { door: null, outcome: "unavailable", status: "offline" },
  ])(
    "publishes $outcome after one automatic Connect exchange attempt",
    async ({ door, outcome, status }) => {
      const port = testPort({ held: false, realCredentials: true });
      const { client } = open(port.factory);
      await client.initialize();
      await client.catalog.upsert(connectComputer(1));
      const establish = vi
        .spyOn(client.sessionExchange, "establish")
        .mockRejectedValue(new HostSessionExchangeError(outcome, `Exchange ${outcome}.`));

      await client.select(serverId);
      await settle();

      expect(establish).toHaveBeenCalledTimes(1);
      expect(client.getSnapshot().selection.row).toMatchObject({ signIn: door, status });
      expect(port.attached).toEqual([]);
      client.dispose();
    },
  );

  it("lets an explicit retry make one new Connect exchange attempt", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(connectComputer(1));
    const establish = vi
      .spyOn(client.sessionExchange, "establish")
      .mockRejectedValueOnce(
        new HostSessionExchangeError("unavailable", "The route did not answer."),
      )
      .mockResolvedValue(sessionExchangeResponse());

    await client.select(serverId);
    expect(establish).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().selection.row?.status).toBe("offline");

    await client.retrySelection();
    await settle();

    expect(establish).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    client.dispose();
  });

  it("opens a team's authorization server without selecting it", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
    );
    await client.initialize();
    await client.signIn(serverId);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("https://host.example.com");
    expect(client.getSnapshot().selection.deploymentId).toBeNull();
    expect(port.attached).toEqual([]);
    expect(port.credentialRequests).toEqual([]);
    client.dispose();
  });

  it("leaves a Connect computer offline when no Account service can issue its grant", async () => {
    // No Account service in this build, so there is nobody to sign the grant
    // the route needs. The row has to say so rather than attach without one.
    const port = testPort({ held: false });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);

    expect(port.attached).toEqual([]);
    expect(client.getSnapshot().selection.row?.status).toBe("offline");
    expect(client.getSnapshot().selection.row?.signIn).toBeNull();
    await expect(client.signIn(serverId)).rejects.toThrow();
    client.dispose();
  });

  it("says Needs sign-in when the attached Host refuses the credential this phone still holds", async () => {
    // A session revoked from a browser leaves this device's record untouched,
    // so the store still answers "held". Only the Host knows, and it said no.
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    await settle();
    expect(client.getSnapshot().selection.row?.status).toBe("connected");

    port.refusals.at(-1)?.();
    await settle();

    expect(client.getSnapshot().selection.row?.status).toBe("needs-sign-in");
    expect(client.getSnapshot().selection.row?.signIn).toBe("pairing-code");
    client.dispose();
  });

  it("replaces a refused personal attachment only after a new pairing session is stored", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.select(serverId);
    await settle();
    port.refusals.at(-1)!();
    await settle();
    expect(port.attached).toHaveLength(1);
    await client.sessions.save(personalSession());
    await vi.waitFor(() => expect(port.attached).toHaveLength(2));
    expect(port.disposed).toEqual([serverId]);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    client.dispose();
  });

  it("keeps a newer computer selection when a team's OAuth callback arrives", async () => {
    const port = testPort({ held: true });
    const files = blockedSelectionWrites(new MemoryPrivateFilesystem());
    const { client, opened } = open(port.factory, files.filesystem);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: otherId })),
    );
    await client.initialize();
    await client.deselect();
    await client.signIn(serverId);
    const state = new URL(opened.at(-1)!).searchParams.get("state")!;
    const blocked = files.blockNext();
    const switching = client.select(otherId);
    await blocked.started;
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    blocked.release();
    await switching;
    await settle();
    expect(client.getSnapshot().selection.deploymentId).toBe(otherId);
    expect(port.attached.at(-1)?.deploymentId).toBe(otherId);
    expect(client.getSnapshot().rows.some((row) => row.deploymentId === serverId)).toBe(false);
    client.dispose();
  });
});

describe("MobileClient attachment identity", () => {
  it("never pairs one deployment's credential with another deployment's address", async () => {
    const port = testPort({ held: true });
    const files = new MemoryPrivateFilesystem();
    const reads = overtakenCatalogReads(files);
    const { client } = open(port.factory, reads.filesystem);
    // Two Deployments on two different addresses: the Personal computer is
    // reached on its signed route, the server on its canonical origin.
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({ kind: "personal", deploymentId: otherId, name: "elsewhere" }),
      ),
    );
    await client.initialize();

    // The catalog's selection moves to the server while the Personal computer
    // is being selected, in the window between its own catalog write and the
    // fence reading that write back.
    reads.afterNextCatalogWrite(async () => {
      await client.catalog.select(otherId);
    });
    await client.select(serverId);
    await settle();

    for (const attachment of port.attached) {
      expect({ deploymentId: attachment.deploymentId, origin: attachment.origin }).not.toEqual({
        deploymentId: serverId,
        origin: "https://host.example.com",
      });
      expect({ deploymentId: attachment.deploymentId, origin: attachment.origin }).not.toEqual({
        deploymentId: otherId,
        origin: "https://route.example.com",
      });
    }
    // And it settles rather than being left half selected.
    const selection = client.getSnapshot().selection;
    expect(selection.deploymentId).toBe(serverId);
    expect(port.attached.at(-1)?.origin).toBe("https://route.example.com");
    client.dispose();
  });
});

describe("MobileClient version verification", () => {
  it("asks the route the attachment uses, not the Personal computer's loopback", async () => {
    const port = testPort({ held: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    await settle();

    // The canonical origin of a Personal computer is its own loopback, which is
    // not an address a phone can reach at all.
    expect(port.verified).toEqual(["https://route.example.com"]);
    client.dispose();
  });

  it("sends no Host traffic after a live protocol mismatch", async () => {
    const port = testPort({ held: true, verification: "host-too-old" });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    await settle();

    expect(client.getSnapshot().selection.row).toMatchObject({
      status: "update-required",
      verification: "host-too-old",
    });
    expect(port.attached).toEqual([]);
    expect(port.credentialRequests).toEqual([]);
    client.dispose();
  });

  it("does not attach when verification finishes after the client is disposed", async () => {
    const port = testPort({ held: true });
    const verdict = Promise.withResolvers<HostEpochAgreement>();
    const started = Promise.withResolvers<void>();
    const { client } = open((options) => ({
      ...port.factory(options),
      verifyEpoch: async () => {
        started.resolve();
        return verdict.promise;
      },
    }));
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    const selection = client.select(serverId);
    await started.promise;
    expect(port.attached).toEqual([]);
    expect(port.credentialRequests).toEqual([]);
    client.dispose();
    verdict.resolve({ status: "compatible", capabilities: [] });
    await selection;
    expect(port.attached).toEqual([]);
    expect(port.credentialRequests).toEqual([]);
  });

  it("keeps an unreachable route offline and retries verification on foreground", async () => {
    const options: { held: boolean; verification: HostEpochAgreement } = {
      held: true,
      verification: "unreachable",
    };
    const port = testPort(options);
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.select(serverId);
    expect(port.attached).toEqual([]);
    expect(client.getSnapshot().selection.row?.status).toBe("offline");
    options.verification = { status: "compatible", capabilities: [] };
    await client.foregrounded();
    expect(port.attached).toHaveLength(1);
    client.dispose();
  });
});

describe("MobileClient per-deployment sign out", () => {
  it("revokes a team's OAuth credential while retaining its independent team listing", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client, opened } = open(port.factory);
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "team", deploymentId: serverId })),
    );
    await client.initialize();
    await client.signIn(serverId);
    const state = new URL(opened.at(-1)!).searchParams.get("state")!;
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await settle();
    expect(client.getSnapshot().teams[0]?.signedIn).toBe(true);
    await client.signOut(serverId);
    await settle();
    expect(client.getSnapshot().teams[0]?.signedIn).toBe(false);
    expect(client.getSnapshot().selection.deploymentId).toBeNull();
    expect(client.getSnapshot().rows).toEqual([]);
    expect(client.getSnapshot().catalog.deployments).toHaveLength(1);
    expect(port.attached).toEqual([]);
    client.dispose();
  });

  it("revokes a Personal computer's own session before discarding it", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();
    const attachment = client.getSnapshot().selection.hostClient;
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    const before = await attachment?.rpc["sessions.list"]({});
    expect(before?.ok === true && before.data.sessions).toHaveLength(1);

    if (!before?.ok) throw new Error("The phone's session was not listed");
    await client.removeHostSession(before.data.sessions[0]!);
    await settle();

    // The Host ended the session this phone was presenting, and the record it
    // presented is gone from the device.
    expect(port.commands).toEqual(["session.revoke"]);
    expect(await client.sessions.load(DeploymentIdSchema.parse(serverId))).toBeNull();
    const row = client.getSnapshot().rows.find((candidate) => candidate.deploymentId === serverId);
    expect(row?.status).toBe("needs-sign-in");
    expect(row?.signIn).toBe("account-grant");
    client.dispose();
  });

  it("discards a Connect exchange that resolves while sign-out is in progress", async () => {
    const memory = new MemoryPrivateFilesystem();
    const files = blockedSignedOutWrites(memory);
    const records = createSecureRecordStore({
      keyPrefix: "exchange-sign-out",
      secureStore: new MemorySecureStore(),
    });
    const port = testPort({ held: false, realCredentials: true });
    const { client } = open(port.factory, files.filesystem, { records });
    await client.initialize();
    await client.catalog.upsert(connectComputer(1));
    const exchange = deferred<ReturnType<typeof sessionExchangeResponse>>();
    const started = deferred<void>();
    vi.spyOn(client.sessionExchange, "establish").mockImplementation(async () => {
      started.resolve();
      return exchange.promise;
    });

    const selection = client.select(serverId);
    await started.promise;
    const blocked = files.blockNext();
    const signingOut = client.signOut(serverId);
    await blocked.started;
    exchange.resolve(sessionExchangeResponse());
    blocked.release();
    await Promise.all([selection, signingOut]);

    expect(await client.sessions.load(DeploymentIdSchema.parse(serverId))).toBeNull();
    client.dispose();

    const relaunchedPort = testPort({ held: false, realCredentials: true });
    const relaunched = open(relaunchedPort.factory, memory, { records });
    const establish = vi
      .spyOn(relaunched.client.sessionExchange, "establish")
      .mockResolvedValue(sessionExchangeResponse());
    await relaunched.client.initialize();
    await settle();

    expect(await relaunched.client.sessions.load(DeploymentIdSchema.parse(serverId))).toBeNull();
    expect(relaunched.client.getSnapshot().selection).toMatchObject({
      deploymentId: serverId,
      hostClient: null,
      row: { status: "needs-sign-in" },
    });
    expect(establish).not.toHaveBeenCalled();
    relaunched.client.dispose();
  });

  it("keeps the signed-out deployment selected without signing it straight back in", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const files = new MemoryPrivateFilesystem();
    const { client } = open(port.factory, files);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();
    expect(files.text("/private/selection.json")).toContain(serverId);

    await client.signOut(serverId);
    await settle();

    // Catalog reconciliation and retries keep the selected context detached;
    // only a later person-initiated sign-in or open lifts the suppression.
    expect(files.text("/private/selection.json")).toContain(serverId);
    expect(client.getSnapshot().selection.deploymentId).toBe(serverId);
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    expect(client.getSnapshot().selection.row?.status).toBe("needs-sign-in");
    expect(port.attached).toHaveLength(1);

    const establish = vi
      .spyOn(client.sessionExchange, "establish")
      .mockResolvedValue(sessionExchangeResponse());
    await client.retrySelection();
    expect(client.getSnapshot().selection.deploymentId).toBe(serverId);
    expect(port.attached).toHaveLength(1);
    expect(establish).not.toHaveBeenCalled();

    await client.openDeployment(serverId);
    await settle();

    expect(establish).toHaveBeenCalledTimes(1);
    expect(port.attached).toHaveLength(2);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    client.dispose();
  });

  it("keeps a remembered deployment signed out across an app restart", async () => {
    const files = new MemoryPrivateFilesystem();
    const firstPort = testPort({ held: false, realCredentials: true });
    const first = open(firstPort.factory, files);
    await first.client.catalog.upsertAndSelect(connectComputer(1));
    await first.client.initialize();
    await first.client.sessions.save(personalSession());
    await first.client.retrySelection();
    await settle();
    await first.client.signOut(serverId);
    await settle();
    first.client.dispose();

    const relaunchedPort = testPort({ held: false, realCredentials: true });
    const relaunched = open(relaunchedPort.factory, files);
    const establish = vi
      .spyOn(relaunched.client.sessionExchange, "establish")
      .mockResolvedValue(sessionExchangeResponse());
    await relaunched.client.initialize();
    await settle();

    expect(relaunched.client.getSnapshot().selection).toMatchObject({
      deploymentId: serverId,
      hostClient: null,
      row: { status: "needs-sign-in" },
    });
    expect(establish).not.toHaveBeenCalled();
    expect(relaunchedPort.attached).toEqual([]);

    await relaunched.client.openDeployment(serverId);
    await settle();

    expect(establish).toHaveBeenCalledTimes(1);
    expect(relaunchedPort.attached).toHaveLength(1);
    expect(relaunched.client.getSnapshot().selection.row?.status).toBe("connected");
    relaunched.client.dispose();
  });

  it("serializes clearing one suppression with adding another", async () => {
    const memory = new MemoryPrivateFilesystem();
    const files = blockedSignedOutWrites(memory);
    const port = testPort({ held: false, realCredentials: true });
    const first = open(port.factory, files.filesystem);
    await first.client.initialize();
    await first.client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          deploymentId: serverId,
          kind: "personal",
          route: { kind: "private" },
        }),
      ),
    );
    await first.client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          deploymentId: otherId,
          kind: "personal",
          name: "other computer",
          route: { generation: 1, kind: "connect" },
        }),
      ),
    );
    await settle();
    await first.client.signOut(serverId);

    const blocked = files.blockNext();
    const clearing = first.client.openDeployment(serverId);
    await blocked.started;
    const adding = first.client.signOut(otherId);
    blocked.release();
    await Promise.all([clearing, adding]);
    first.client.dispose();

    expect(JSON.parse(memory.text("/private/signed-out.json") ?? "")).toEqual({
      deploymentIds: [otherId],
      schemaVersion: 1,
    });

    const relaunched = open(testPort({ held: false, realCredentials: true }).factory, memory);
    const establish = vi
      .spyOn(relaunched.client.sessionExchange, "establish")
      .mockResolvedValue(sessionExchangeResponse());
    await relaunched.client.initialize();
    await relaunched.client.select(otherId);
    await settle();

    expect(establish).not.toHaveBeenCalled();
    expect(relaunched.client.getSnapshot().selection.row).toMatchObject({
      deploymentId: otherId,
      status: "needs-sign-in",
    });
    relaunched.client.dispose();
  });

  it("keeps the credential when the Host refuses the revocation", async () => {
    const port = testPort({ held: false, realCredentials: true, refusesCommands: true });
    const { client } = open(port.factory);
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();

    await expect(client.signOut(serverId)).rejects.toThrow(/refused the command/u);
    await settle();

    // Nothing was revoked, so nothing may be discarded: a phone that dropped
    // the record here could never end a credential the Host still honours.
    expect(await client.sessions.load(DeploymentIdSchema.parse(serverId))).not.toBeNull();
    const row = client.getSnapshot().rows.find((candidate) => candidate.deploymentId === serverId);
    expect(row?.status).toBe("connected");
    // The login and its live attachment remain; only the saved view stays erased.
    expect(client.getSnapshot().selection.hostClient).not.toBeNull();
    client.dispose();
  });
});

/*
 * This iPhone's own apps, as the phone's sign-out, removal and Account paths
 * must treat them. The iPhone is the labelled JS fake of the native bridge, run
 * by the real controller; the Host is the in-memory mock.
 *
 * Failure cases, written before the hooks:
 * - J1: sharing keeps running across an await of a sign-out, removal or
 *   Account sign-out of the Deployment that holds it;
 * - the Host is told only after the credential that could tell it is gone;
 * - an Account sign-out stops an iPhone whose Deployment the Account does not
 *   list, or signing out of another Deployment stops it at all;
 * - a Deployment that leaves the catalog keeps the iPhone sharing with it;
 * - J2: a Host that cannot be told holds up or undoes the sign-out, or the
 *   person is never told the Host still lists the iPhone.
 */
describe("MobileClient and this iPhone's apps", () => {
  const laptopRunnerId = "rnr_33333333-3333-4333-8333-333333333333";

  function iphoneOn(deploymentId: string) {
    const fake = createFakeIphoneApps({ deviceName: "Alex's iPhone", runnerId: laptopRunnerId });
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const controller = new IphoneAppsController({
      bridge: fake.bridge,
      shownApprovals: { read: async () => [], write: async () => undefined },
      timing: { approvalWaitMs: 50, enrollWaitMs: 50, revokeMs: 50 },
    });
    return { controller, fake };
  }

  it("J1: stops sharing before a sign-out awaits, then tells the Host while signed in", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const iphone = iphoneOn(serverId);
    const { client } = open(port.factory, undefined, { iphoneApps: iphone.controller.owner });
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();

    const signingOut = client.signOut(serverId);
    expect(iphone.fake.device.calls).toEqual(["disconnect"]);
    await signingOut;
    await settle();

    expect(port.commands).toEqual(["machine.revoke", "session.revoke"]);
    expect(iphone.controller.getState().notice).toBeNull();
    expect(iphone.controller.owner.enrolledDeploymentId()).toBeNull();
    iphone.controller.dispose();
    client.dispose();
  });

  it("J1: stops sharing before removing its Deployment awaits anything", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const iphone = iphoneOn(serverId);
    const { client } = open(port.factory, undefined, { iphoneApps: iphone.controller.owner });
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();

    const removing = client.remove(serverId);
    expect(iphone.fake.device.calls).toEqual(["disconnect"]);
    await removing;

    expect(port.commands).toEqual(["machine.revoke", "session.revoke"]);
    expect(client.getSnapshot().catalog.deployments).toHaveLength(0);
    iphone.controller.dispose();
    client.dispose();
  });

  it("J1: an Account sign-out stops only an iPhone whose Deployment the Account lists", async () => {
    const listed = iphoneOn(serverId);
    const port = testPort({ held: false });
    const { client } = open(port.factory, undefined, { iphoneApps: listed.controller.owner });
    await client.catalog.upsertAndSelect(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: serverId,
          source: { issuer: accountOrigin, kind: "account", subject: accountSubject },
        }),
      ),
    );
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: otherId,
          name: "manual server",
        }),
      ),
    );
    await client.initialize();

    const signingOut = client.signOutAccount();
    expect(listed.fake.device.calls).toEqual(["disconnect"]);
    await signingOut;
    listed.controller.dispose();
    client.dispose();

    const manual = iphoneOn(otherId);
    const second = open(testPort({ held: false }).factory, undefined, {
      iphoneApps: manual.controller.owner,
    });
    await second.client.catalog.upsertAndSelect(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: serverId,
          source: { issuer: accountOrigin, kind: "account", subject: accountSubject },
        }),
      ),
    );
    await second.client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: otherId,
          name: "manual server",
        }),
      ),
    );
    await second.client.initialize();
    await second.client.signOutAccount();
    await settle();

    expect(manual.fake.device.calls).toEqual([]);
    expect(manual.controller.owner.enrolledDeploymentId()).toBe(otherId);
    manual.controller.dispose();
    second.client.dispose();
  });

  it("leaves the iPhone sharing when another Deployment is signed out", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const iphone = iphoneOn(otherId);
    const { client } = open(port.factory, undefined, { iphoneApps: iphone.controller.owner });
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: otherId,
          name: "manual server",
        }),
      ),
    );
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();

    await client.signOut(serverId);
    await settle();

    expect(iphone.fake.device.calls).toEqual([]);
    expect(port.commands).toEqual(["session.revoke"]);
    iphone.controller.dispose();
    client.dispose();
  });

  it("stops an iPhone whose Deployment left the catalog, with nothing left to tell", async () => {
    const port = testPort({ held: false });
    const iphone = iphoneOn(otherId);
    const { client } = open(port.factory, undefined, { iphoneApps: iphone.controller.owner });
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.catalog.upsert(
      asInput(
        testDeploymentConnection({
          kind: "personal",
          deploymentId: otherId,
          name: "manual server",
        }),
      ),
    );
    await client.initialize();
    await settle();
    expect(iphone.fake.device.calls).toEqual([]);

    await client.catalog.remove(DeploymentIdSchema.parse(otherId));
    await settle();

    expect(iphone.fake.device.calls).toEqual(["disconnect"]);
    expect(port.commands).toEqual([]);
    expect(iphone.controller.getState().notice).toBeNull();
    iphone.controller.dispose();
    client.dispose();
  });

  it("J2: signs out even when the Host cannot be told, and says so", async () => {
    const port = testPort({
      configureClient: (hostClient) => {
        const dispatch = hostClient.dispatch.bind(hostClient);
        hostClient.dispatch = async (command) => {
          if (command.type === "machine.revoke") throw new Error("That deployment is asleep.");
          return dispatch(command);
        };
      },
      held: false,
      realCredentials: true,
    });
    const iphone = iphoneOn(serverId);
    const { client } = open(port.factory, undefined, { iphoneApps: iphone.controller.owner });
    await client.catalog.upsertAndSelect(connectComputer(1));
    await client.initialize();
    await client.sessions.save(personalSession());
    await client.retrySelection();
    await settle();

    await client.signOut(serverId);
    await settle();

    expect(port.commands).toEqual(["machine.revoke", "session.revoke"]);
    expect(await client.sessions.load(DeploymentIdSchema.parse(serverId))).toBeNull();
    expect(iphone.controller.getState().notice).toEqual({
      deploymentId: serverId,
      deploymentName: "Mac mini",
      kind: "not-told",
      name: "Alex's iPhone",
    });
    expect(iphone.controller.owner.enrolledDeploymentId()).toBeNull();
    iphone.controller.dispose();
    client.dispose();
  });
});

// Session usability is relative to the real clock these integration-style
// client tests use. A calendar expiry makes otherwise healthy fixtures expire.
const fixtureSessionExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const fixtureAbsoluteExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();

/** A header-delivered session of the shape the exchange returns. */
function personalSession() {
  return {
    absoluteExpiresAt: fixtureAbsoluteExpiresAt,
    deploymentId: DeploymentIdSchema.parse(serverId),
    expiresAt: fixtureSessionExpiresAt,
    token: `${"a".repeat(43)}.${"b".repeat(43)}=`,
  };
}

function sessionExchangeResponse() {
  return SessionExchangeResponseSchema.parse({
    credential: {
      absoluteExpiresAt: fixtureAbsoluteExpiresAt,
      expiresAt: fixtureSessionExpiresAt,
      token: `${"a".repeat(43)}.${"b".repeat(43)}=`,
    },
    credentialDelivery: "header",
    schemaVersion: 2,
    session: {
      absoluteExpiresAt: fixtureAbsoluteExpiresAt,
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: fixtureSessionExpiresAt,
      id: createId("authSession"),
      user: {
        disabledAt: null,
        displayName: "Operator",
        email: "operator@opensteer.test",
        emailVerified: true,
        id: createId("user"),
        image: null,
        instanceRole: "administrator",
      },
    },
  });
}

/** Lets the catalog's subscribers, which reconcile asynchronously, run. */
const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 8; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

it("keeps previews when an Account sign-in starts and is left unfinished", async () => {
  const port = testPort({ held: true });
  const previews = new NotificationPreviews(null, {} as never, async () => null);
  const clear = vi.spyOn(previews, "clear");
  const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
    accountOrigin,
    fetch: accountFetch(),
    notificationPreviews: previews,
  });
  try {
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    await client.oauth.beginAccountSignIn();
    expect(clear).not.toHaveBeenCalled();
  } finally {
    client.dispose();
  }
});

it("refreshes previews when Account sign-in returns on a retained manual Host", async () => {
  const port = testPort({ held: true });
  const previews = new NotificationPreviews(null, {} as never, async () => null);
  const attach = vi.spyOn(previews, "attach");
  const { client, opened } = open(port.factory, new MemoryPrivateFilesystem(), {
    accountOrigin,
    fetch: accountFetch(),
    notificationPreviews: previews,
  });
  try {
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ kind: "personal", deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    await vi.waitFor(() => expect(attach).toHaveBeenCalled());
    await client.clearAccountSavedViews();
    attach.mockClear();
    const connections = port.attached.length;
    await signInTestAccount(client, opened);
    await vi.waitFor(() => expect(attach).toHaveBeenCalled());
    expect(port.attached).toHaveLength(connections);
  } finally {
    client.dispose();
  }
});

describe("pending computer destination", () => {
  it("suppresses startup singleton selection and asks for Account sign-in", async () => {
    const { client } = open(testPort({ held: false }).factory);
    await client.catalog.upsert(asInput(testDeploymentConnection({ kind: "personal" })));
    client.openComputer(serverId);
    await client.initialize();
    expect(client.getSnapshot().selection.deploymentId).toBeNull();
    expect(client.getSnapshot().pendingComputer).toEqual({
      deploymentId: serverId,
      status: "needs-sign-in",
    });
    client.cancelOpenComputer();
    expect(client.getSnapshot().pendingComputer).toBeNull();
    client.dispose();
  });

  it("opens the exact Account entry after sign-in without waiting for a Host", async () => {
    const verification = deferred<HostEpochAgreement>();
    const port = testPort({ held: false });
    const { client, opened } = open(
      (options) => ({ ...port.factory(options), verifyEpoch: () => verification.promise }),
      undefined,
      {
        accountOrigin,
        fetch: accountFetch(),
      },
    );
    client.openComputer(serverId);
    vi.spyOn(client.accountDirectory, "sync").mockImplementation(async () => {
      await client.catalog.upsert(
        asInput(
          testDeploymentConnection({
            kind: "personal",
            source: { kind: "account", issuer: accountOrigin, subject: accountSubject },
          }),
        ),
      );
      return { syncedDeploymentIds: [DeploymentIdSchema.parse(serverId)], unavailable: [] };
    });
    await client.initialize();
    await signInTestAccount(client, opened);
    await vi.waitFor(() => expect(client.getSnapshot().selection.deploymentId).toBe(serverId), {
      timeout: 2000,
    });
    expect(client.getSnapshot().pendingComputer).toBeNull();
    verification.resolve("unreachable");
    client.dispose();
  });

  it.each(["not-listed", "offline"] as const)(
    "shows %s without selecting a manual entry",
    async (status) => {
      const { client, opened } = open(testPort({ held: false }).factory, undefined, {
        accountOrigin,
        fetch: accountFetch(),
      });
      client.openComputer(serverId);
      vi.spyOn(client.accountDirectory, "sync").mockResolvedValue({
        syncedDeploymentIds: [DeploymentIdSchema.parse(serverId)],
        unavailable:
          status === "offline"
            ? [
                {
                  deploymentId: DeploymentIdSchema.parse(serverId),
                  name: "Mac",
                  accountAccess: "owner",
                  reason: "host-unavailable",
                },
              ]
            : [],
      });
      await client.initialize();
      await client.catalog.upsert(asInput(testDeploymentConnection({ kind: "personal" })));
      await signInTestAccount(client, opened);
      await vi.waitFor(() => expect(client.getSnapshot().pendingComputer?.status).toBe(status), {
        timeout: 2000,
      });
      expect(client.getSnapshot().selection.deploymentId).toBeNull();
      client.dispose();
    },
  );
});

describe("pending computer fencing", () => {
  it.each(["sign-out", "newer-link", "cancel"] as const)(
    "discards directory completion after %s",
    async (action) => {
      const { client, opened } = open(testPort({ held: false }).factory, undefined, {
        accountOrigin,
        fetch: accountFetch(),
      });
      vi.spyOn(client.accountDirectory, "sync").mockResolvedValue({
        syncedDeploymentIds: [],
        unavailable: [],
      });
      await client.initialize();
      await signInTestAccount(client, opened);
      await client.refreshDirectory();
      const refresh = deferred<void>();
      vi.spyOn(client.directoryRefresh, "refreshNow").mockReturnValue(refresh.promise);
      client.openComputer(serverId);
      const completion = client.retryOpenComputer();
      if (action === "sign-out") {
        const signingOut = client.signOutAccount();
        expect(client.getSnapshot().pendingComputer).toBeNull();
        await signingOut;
      } else if (action === "newer-link") {
        client.openComputer(otherId);
      } else client.cancelOpenComputer();
      refresh.resolve();
      await completion;
      expect(client.getSnapshot().selection.deploymentId).toBeNull();
      if (action === "newer-link") {
        await vi.waitFor(
          () =>
            expect(client.getSnapshot().pendingComputer).toEqual({
              deploymentId: otherId,
              status: "not-listed",
            }),
          { timeout: 2000 },
        );
      } else expect(client.getSnapshot().pendingComputer).toBeNull();
      client.dispose();
    },
  );
});

it("restarts a pending computer link when an earlier selection lands mid-lookup", async () => {
  const { client, opened } = open(testPort({ held: false }).factory, undefined, {
    accountOrigin,
    fetch: accountFetch(),
  });
  vi.spyOn(client.accountDirectory, "sync").mockResolvedValue({
    syncedDeploymentIds: [],
    unavailable: [],
  });
  const thirdId = createId("deployment");
  await client.catalog.upsert(
    asInput(testDeploymentConnection({ kind: "personal", deploymentId: otherId })),
  );
  await client.catalog.upsert(
    asInput(testDeploymentConnection({ kind: "personal", deploymentId: thirdId })),
  );
  await client.initialize();
  await signInTestAccount(client, opened);
  await client.refreshDirectory();
  await client.select(otherId);
  const refresh = deferred<void>();
  vi.spyOn(client.directoryRefresh, "refreshNow").mockReturnValue(refresh.promise);
  // A switch the person started before the link arrived lands mid-lookup.
  const selecting = client.select(thirdId);
  client.openComputer(serverId);
  const completion = client.retryOpenComputer();
  await selecting;
  refresh.resolve();
  await completion;
  await vi.waitFor(
    () =>
      expect(client.getSnapshot().pendingComputer).toEqual({
        deploymentId: serverId,
        status: "not-listed",
      }),
    { timeout: 2000 },
  );
  client.dispose();
});

it("retains a cold computer intent above the remembered selection", async () => {
  const files = new MemoryPrivateFilesystem();
  await files.writeFileAtomic(
    "/private/selection.json",
    JSON.stringify({ schemaVersion: 1, selectedDeploymentId: serverId }),
  );
  const { client } = open(testPort({ held: false }).factory, files);
  await client.catalog.upsert(asInput(testDeploymentConnection({ kind: "personal" })));
  client.openComputer(otherId);
  await client.initialize();
  expect(client.getSnapshot().pendingComputer).toEqual({
    deploymentId: otherId,
    status: "needs-sign-in",
  });
  expect(client.getSnapshot().selection.deploymentId).toBe(serverId);
  client.dispose();
});
