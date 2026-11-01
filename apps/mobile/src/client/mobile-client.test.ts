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
import { createMemorySavedViews } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  buildNativeIntegrationAuthorizationCallback,
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
  const workspaceRefusals: (() => void)[] = [];
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
      let refused = false,
        workspaceRefused = false;
      workspaceRefusals.push(() => {
        workspaceRefused = true;
        for (const listener of listeners) listener();
      });
      refusals.push(() => {
        refused = true;
        for (const listener of listeners) listener();
      });
      return new Proxy(hostClient, {
        get(target, property) {
          if (property === "getSnapshot") {
            return () => ({
              ...target.getSnapshot(),
              ...(refused ? { session: "authentication-required" as const } : {}),
              ...(workspaceRefused
                ? {
                    savedViewReadiness: {
                      tasksReady: false,
                      home: { status: "unknown" as const },
                      workspaceRefusal: 1,
                    },
                  }
                : {}),
            });
          }
          if (property === "dispatch") {
            return (command: { readonly type: string }) => {
              commands.push(command.type);
              if (options.refusesCommands === true) {
                return Promise.reject(new Error("That deployment refused the command."));
              }
              return target.dispatch(command as Parameters<typeof target.dispatch>[0]);
            };
          }
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
    workspaceRefusals,
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
    doneShelfFilePath: "/private/done-shelf.json",
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
    const port = testPort({ held: true });
    let openedLaunch = "";
    const { client } = open(port.factory, new MemoryPrivateFilesystem(), {
      openIntegrationAuthorization: async (launchUrl) => {
        openedLaunch = launchUrl;
        const attemptId = new URL(launchUrl).pathname.split("/").at(-2)!;
        return buildNativeIntegrationAuthorizationCallback({
          attemptId: IntegrationOAuthAttemptIdSchema.parse(attemptId),
          deploymentId: DeploymentIdSchema.parse(serverId),
        });
      },
    });
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
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
    expect(port.commands).toContain("integration.authorization.begin");
    client.dispose();
  });

  it("uses the same verified native return for MCP authorization", async () => {
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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
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
    expect(opened).toContain(`/v1/integration-authorizations/${attemptId}/launch`);
    expect(status).toHaveBeenCalledWith(attemptId);
    client.dispose();
  });

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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
    await client.initialize();
    await client.select(serverId);

    await expect(client.beginIntegrationAuthorization({ definitionId: "slack" })).rejects.toThrow(
      /different integration attempt/u,
    );
    client.dispose();
  });

  it("refuses a cold callback for a Deployment outside the verified catalog", async () => {
    const { client } = open(testPort({ held: true }).factory);
    await client.initialize();
    const callback = buildNativeIntegrationAuthorizationCallback({
      attemptId: IntegrationOAuthAttemptIdSchema.parse("ioa_00000000-0000-4000-8000-000000000099"),
      deploymentId: DeploymentIdSchema.parse(serverId),
    });
    await expect(client.handleIntegrationAuthorizationCallback(callback)).rejects.toThrow(
      /unknown deployment/u,
    );
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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));

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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));

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
      asInput(testDeploymentConnection({ deploymentId: serverId })),
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
          deploymentId: serverId,
          source: { issuer: accountOrigin, kind: "account", subject: accountSubject },
        }),
      ),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "manual server" })),
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
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "available" })),
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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "new server" })),
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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "elsewhere" })),
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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "elsewhere" })),
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
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "remaining" })),
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
    port.workspaceRefusals.at(-1)!();
    await started.promise;
    await client.retrySelection();
    await settle();
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    await client.savedViews.flush();
    expect(write).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(async () => {
      await client.savedViews.flush();
      expect(write).toHaveBeenCalled();
    });
    expect(client.getSnapshot().savedViewFailure).toBeNull();
    expect(client.savedViews.getSnapshot().home.source).not.toBe("saved");
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
      expect(client.savedViews.getSnapshot().home.source).not.toBe("saved");
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
        deploymentId: serverId,
        source: { kind: "account", issuer: accountOrigin, subject },
      });
    await client.catalog.upsert(asInput(accountConnection()));
    await client.select(serverId);
    await client.signIn(serverId);
    const state = new URL(opened.at(-1)!).searchParams.get("state")!;
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().tasks.source).toBe("live"));
    await settle();
    await client.savedViews.flush();
    const before = write.mock.calls.at(-1)![0],
      hostLogin = client.oauth.hostViewLoginId(accountConnection());
    expect(before.accountSource?.subject).toBe(accountSubject);
    expect(await store.load(before, () => true)).toEqual(before);
    const signing = client.oauth.beginAccountSignIn();
    expect(client.savedViews.getSnapshot().home.source).toBe("blocked");
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    await signing;
    expect(encrypted.slots()).toEqual([]);
    expect(client.oauth.hostViewLoginId(accountConnection())).toBe(hostLogin);
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
    await client.signIn(serverId);
    const hostState = new URL(opened.at(-1)!).searchParams.get("state")!;
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${hostState}`,
    );
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

  it.each(["workspace", "authentication", "marker-write"] as const)(
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
      if (reason === "authentication") port.refusals.at(-1)!();
      else port.workspaceRefusals.at(-1)!();
      expect(client.savedViews.getSnapshot().home.source).toBe("blocked");
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
    const { client: first, opened } = open(firstPort.factory, files, {
      records,
      savedViewStore: store,
    });
    await first.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await first.initialize();
    await first.signIn(serverId);
    const state = new URL(opened.at(-1)!).searchParams.get("state")!;
    await first.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
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
                  home: { status: "unknown" },
                  workspaceRefusal: 0,
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
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().home.source).toBe("saved"));
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
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().home.source).toBe("live"));
    await client.savedViews.flush();
    expect(await capabilities()).toEqual([]);
    expect(port.verified).toHaveLength(1);
    client.dispose();
  });
  it("does not revive old presentation or capture when local scope initialization crosses interactive sign-in", async () => {
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
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.initialize();
    await vi.waitFor(() => expect(client.getSnapshot().selection.row?.status).toBe("connected"));
    await client.signIn(serverId);
    gate.resolve();
    await settle();
    expect(client.savedViews.getSnapshot().home.source).toBe("blocked");
    await client.savedViews.flush();
    expect(writes).not.toHaveBeenCalled();
    client.dispose();
  });

  it("uses the same controller with synthetic login IDs and memory-only storage in mock mode", async () => {
    const memory = createMemorySavedViews(),
      write = vi.spyOn(memory, "write"),
      secure = new MemorySecureStore();
    const { client } = open(createMockHostPort({ initialHome: "absent" }), undefined, {
      savedViewStore: memory,
      records: createSecureRecordStore({ keyPrefix: "mock-auth", secureStore: secure }),
    });
    const connection = mockDeploymentConnections()[0]!;
    await client.catalog.upsertAndSelect(connection);
    await client.initialize();
    await client.select(connection.authority.document.deploymentId);
    await vi.waitFor(() => expect(client.savedViews.getSnapshot().home.source).toBe("live"));
    await client.savedViews.flush();
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls.at(-1)?.[0]).toMatchObject({
      loginId: expect.any(String),
      home: { threadId: null, messages: [] },
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
    expect(client.savedViews.getSnapshot().home.source).not.toBe("saved");
    expect(load).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    client.dispose();
  });

  it("hides before interactive login, replaces healthy clients, and reconfirms a cancelled login", async () => {
    const port = testPort({ held: true, realCredentials: true });
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
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.initialize();
    const exchange = async () => {
      const state = new URL(opened.at(-1)!).searchParams.get("state")!;
      await client.oauth.handleCallback(
        `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
      );
      await settle();
    };
    await client.signIn(serverId);
    await exchange();
    await vi.waitFor(() => expect(client.getSnapshot().selection.row?.status).toBe("connected"));
    const first = client.getSnapshot().selection.hostClient;
    await client.signIn(serverId);
    expect(deleted).toContain(serverId);
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    await exchange();
    expect(client.getSnapshot().selection.hostClient).not.toBe(first);
    const second = client.getSnapshot().selection.hostClient;
    await client.signIn(serverId);
    client.oauth.abandonHostSignIn(DeploymentIdSchema.parse(serverId));
    await settle();
    expect(client.getSnapshot().selection.hostClient).not.toBe(second);
    expect(port.attached).toHaveLength(3);
    client.dispose();
  });

  it("deletes the saved key before revocation, retaining a visible cleanup failure for retry", async () => {
    const port = testPort({ held: true, realCredentials: true });
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
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
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
    const signingOut = client.signOut(serverId);
    expect(client.getSnapshot().selection.hostClient).toBeNull();
    await signingOut;
    expect(events[0]).toBe("delete-key");
    expect(events).toContain("revoke");
    expect(client.getSnapshot().savedViewFailure).toMatch(/cleanup could not be completed/u);
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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "elsewhere" })),
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

  it("opens Host OAuth for a user-opened self-hosted deployment and attaches after callback", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client, opened } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
    await settle();

    await client.openDeployment(serverId);

    expect(client.getSnapshot().selection.deploymentId).toBe(serverId);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("https://host.example.com");
    expect(port.attached).toEqual([]);

    const state = new URL(opened[0]!).searchParams.get("state") ?? "";
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await settle();

    expect(port.attached).toHaveLength(1);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    client.dispose();
  });

  it("does not open a browser when a self-hosted deployment is selected automatically", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));

    await client.select(serverId);

    expect(opened).toEqual([]);
    expect(client.getSnapshot().selection.row).toMatchObject({
      signIn: "host-oauth",
      status: "needs-sign-in",
    });
    client.dispose();
  });

  it("does not open Host OAuth when opening discovers an identity mismatch", async () => {
    const port = testPort({ held: false, verification: "identity-mismatch" });
    const { client, opened } = open(port.factory);
    await client.initialize();
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "newer choice" })),
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

  it("opens the Host's own authorization server for a self-hosted deployment", async () => {
    const port = testPort({ held: false });
    const { client, opened } = open(port.factory);
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.initialize();

    await client.signIn(serverId);

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("https://host.example.com");
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
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    await settle();
    expect(client.getSnapshot().selection.row?.status).toBe("connected");

    port.refusals.at(-1)?.();
    await settle();

    expect(client.getSnapshot().selection.row?.status).toBe("needs-sign-in");
    expect(client.getSnapshot().selection.row?.signIn).toBe("host-oauth");
    client.dispose();
  });

  it("replaces a refused attachment when the new credential lands, not when the browser opens", async () => {
    const port = testPort({ held: true });
    const { client, opened } = open(port.factory);
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.initialize();
    await client.select(serverId);
    port.refusals.at(-1)?.();
    await settle();

    await client.signIn(serverId);
    await settle();
    // Handing the authorize URL to the browser is not a credential: the code
    // has still to be exchanged, and re-attaching here would send the refused
    // token a second time.
    expect(port.attached).toHaveLength(1);

    const state = new URL(opened.at(-1) ?? "").searchParams.get("state") ?? "";
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await settle();

    // The refused client is latched on the Host's answer, so the credential
    // that just landed reaches the Host only through a new attachment.
    expect(port.disposed).toEqual([serverId]);
    expect(port.attached).toHaveLength(2);
    expect(client.getSnapshot().selection.row?.status).toBe("connected");
    client.dispose();
  });

  it("does not restore a prior deployment when its credential lands behind a newer selection", async () => {
    const port = testPort({ held: true });
    const files = blockedSelectionWrites(new MemoryPrivateFilesystem());
    const { client, opened } = open(port.factory, files.filesystem);
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "elsewhere" })),
    );
    await client.initialize();
    await client.select(serverId);
    await settle();
    port.refusals.at(-1)?.();
    await settle();
    await client.signIn(serverId);
    const state = new URL(opened.at(-1) ?? "").searchParams.get("state") ?? "";

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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "elsewhere" })),
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
  it("drops a Host credential and leaves the deployment listed at Needs sign-in", async () => {
    const port = testPort({ held: false, realCredentials: true });
    const { client, opened } = open(port.factory);
    await client.catalog.upsertAndSelect(
      asInput(testDeploymentConnection({ deploymentId: serverId })),
    );
    await client.initialize();
    await client.signIn(serverId);
    const state = new URL(opened.at(-1) ?? "").searchParams.get("state") ?? "";
    await client.oauth.handleCallback(
      `${opensteerMobileHostOAuthCallback}?code=host-code&iss=https%3A%2F%2Fhost.example.com&state=${state}`,
    );
    await settle();
    await client.select(serverId);
    await settle();
    expect(client.getSnapshot().selection.row?.status).toBe("connected");

    await client.signOut(serverId);
    await settle();

    const snapshot = client.getSnapshot();
    const row = snapshot.rows.find((candidate) => candidate.deploymentId === serverId);
    expect(port.disposed).toEqual([serverId]);
    expect(row?.status).toBe("needs-sign-in");
    expect(row?.signIn).toBe("host-oauth");
    // Signing out is not forgetting: the deployment is still somewhere this
    // phone knows how to reach.
    expect(snapshot.catalog.deployments).toHaveLength(1);
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

    await client.signOut(serverId);
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
          deploymentId: serverId,
          source: { issuer: accountOrigin, kind: "account", subject: accountSubject },
        }),
      ),
    );
    await client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "manual server" })),
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
          deploymentId: serverId,
          source: { issuer: accountOrigin, kind: "account", subject: accountSubject },
        }),
      ),
    );
    await second.client.catalog.upsert(
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "manual server" })),
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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "manual server" })),
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
      asInput(testDeploymentConnection({ deploymentId: otherId, name: "manual server" })),
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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
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
    await client.catalog.upsert(asInput(testDeploymentConnection({ deploymentId: serverId })));
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
