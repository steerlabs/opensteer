import { createId, type EnvironmentId, type RunnerId } from "@opensteer/core";
import { hostApi } from "@opensteer/protocol";
import { hostKeyFingerprint, statesApiVersion } from "@opensteer/deployment-authority";
import {
  AccountLinkGenerationSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  ConnectOperationIdSchema,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import type { PersonalDeploymentManifest } from "../secrets/personal-deployment-store.js";
import {
  NativePersonalHostControl,
  NativePersonalRemoteHostControl,
  personalHostBootstrapUrl,
  PersonalHostRefusalError,
} from "./personal-host-control.js";
import { testPersonalHostRuntime } from "./personal-host-runtime-test-support.js";

const hostOrigin = "http://127.0.0.1:4310";
/** The route under test is the declaration's, never a string typed twice. */
const bootstrapUrl = personalHostBootstrapUrl(hostOrigin).toString();

describe("NativePersonalHostControl bootstrap", () => {
  it("claims on first boot and returns enrollment before reading agent home readiness", async () => {
    const requests: Array<{ readonly credentials: RequestCredentials; readonly request: Request }> =
      [];
    let localBootstrapReads = 0;
    const fetch = vi.fn(
      async (_deploymentId: string, input: URL | RequestInfo, init: RequestInit) => {
        const request = new Request(input, init);
        requests.push({ credentials: init.credentials ?? "same-origin", request });
        if (request.url.endsWith("/v1/rpc/auth.setup.claim")) {
          return ownerClaimRpcData();
        }
        if (request.url.endsWith("/v1/local-bootstrap")) {
          localBootstrapReads += 1;
          return json({
            runnerEnrollmentToken: "runner-enrollment-token-12345",
            setupUrl:
              localBootstrapReads === 1 ? `${hostOrigin}/setup#token=${"a".repeat(43)}` : null,
          });
        }
        return new Response(null, { status: 404 });
      },
    );
    const control = new NativePersonalHostControl({ fetch, requestTimeoutMs: 1_000 });
    const token = "a".repeat(43);
    await expect(
      control.bootstrap(hostOrigin, manifest(), token, new AbortController().signal),
    ).resolves.toEqual({ runnerEnrollmentToken: "runner-enrollment-token-12345" });

    expect(requests.map(({ request }) => `${request.method} ${request.url}`)).toEqual([
      `GET ${hostOrigin}/v1/local-bootstrap`,
      `POST ${hostOrigin}/v1/rpc/auth.setup.claim`,
      `GET ${hostOrigin}/v1/local-bootstrap`,
    ]);
    expect(requests[0]?.request.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(requests[2]?.request.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(requests[1]?.request.headers.get("content-type")).toBe("application/json");
    expect(requests[1]?.request.headers.get("origin")).toBe(hostOrigin);
    await expect(requests[1]?.request.json()).resolves.toEqual({
      kind: "local-machine-owner",
      token,
    });
    expect(requests[0]?.credentials).toBe("omit");
    expect(requests.slice(1).every(({ credentials }) => credentials === "include")).toBe(true);
    for (const { request } of requests)
      expect(statesApiVersion(Object.fromEntries(request.headers), "personal")).toBe(true);
  });

  it("re-establishes the desktop's owner session on restart", async () => {
    const requests: Request[] = [];
    const token = "a".repeat(43);
    const control = new NativePersonalHostControl({
      fetch: async (_deploymentId, input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/v1/rpc/auth.setup.claim")) {
          return ownerClaimRpcData();
        }
        if (request.url.endsWith("/v1/local-bootstrap")) {
          return json({
            runnerEnrollmentToken: "runner-enrollment-token-12345",
            setupUrl: null,
          });
        }
        return new Response(null, { status: 404 });
      },
    });

    await expect(
      control.bootstrap(hostOrigin, manifest(), token, new AbortController().signal),
    ).resolves.toEqual({ runnerEnrollmentToken: "runner-enrollment-token-12345" });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${hostOrigin}/v1/local-bootstrap`,
      `POST ${hostOrigin}/v1/rpc/auth.setup.claim`,
      `GET ${hostOrigin}/v1/local-bootstrap`,
    ]);
    await expect(requests[1]?.json()).resolves.toEqual({
      kind: "local-machine-owner",
      token,
    });
    expect(requests[1]?.headers.get("origin")).toBe(hostOrigin);
    expect(requests.map((request) => request.credentials)).toEqual(["omit", "include", "include"]);
    expect(
      requests
        .filter((request) => request.url.endsWith("/v1/local-bootstrap"))
        .every((request) => request.headers.get("authorization") === `Bearer ${token}`),
    ).toBe(true);
  });

  it("verifies the Personal agent home only when the supervisor asks after Runner attachment", async () => {
    const requests: Request[] = [];
    const deployment = manifest();
    const control = new NativePersonalHostControl({
      fetch: async (_deploymentId, input, init) => {
        requests.push(new Request(input, init));
        return rpcData(hostBootstrap());
      },
    });

    await expect(
      control.ensureAgentHome(hostOrigin, deployment.deploymentId, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(requests.map(({ url }) => url)).toEqual([bootstrapUrl]);
  });

  it("recovers a cleared owner session with one typed claim request", async () => {
    const requests: Request[] = [];
    const token = "a".repeat(43);
    const control = new NativePersonalHostControl({
      fetch: async (_deploymentId, input, init) => {
        requests.push(new Request(input, init));
        return ownerClaimRpcData();
      },
    });

    await expect(
      control.claimOwner(hostOrigin, manifest(), token, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${hostOrigin}/v1/rpc/auth.setup.claim`);
    expect(requests[0]?.headers.get("origin")).toBe(hostOrigin);
    await expect(requests[0]?.json()).resolves.toEqual({ kind: "local-machine-owner", token });
  });

  it("names the rejected session instead of hanging when the Host refuses bootstrap", async () => {
    const deployment = manifest();
    let requests = 0;
    const control = new NativePersonalHostControl({
      fetch: async () => {
        requests += 1;
        return rpcError({ code: "unauthorized", message: "Authentication required" }, 401);
      },
      pollIntervalMs: 1,
      requestTimeoutMs: 1_000,
    });

    await expect(
      control.waitForRunner(
        hostOrigin,
        deployment.deploymentId,
        deployment.environmentId,
        deployment.runnerId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "unauthorized",
      name: "PersonalHostBootstrapRefusedError",
    });
    // A settled refusal ends the wait on the first answer, never on a deadline.
    expect(requests).toBe(1);
  });

  it("keeps polling while a starting Host answers with a retryable fault", async () => {
    const deployment = manifest();
    let requests = 0;
    const control = new NativePersonalHostControl({
      fetch: async () => {
        requests += 1;
        if (requests === 1) {
          return rpcError({ code: "internal", message: "Host is starting" }, 500);
        }
        return rpcData(
          hostBootstrap({
            environments: [environment(deployment.environmentId, deployment.runnerId)],
          }),
        );
      },
      pollIntervalMs: 1,
      requestTimeoutMs: 1_000,
    });

    await expect(
      control.waitForRunner(
        hostOrigin,
        deployment.deploymentId,
        deployment.environmentId,
        deployment.runnerId,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(requests).toBe(2);
  });

  it("refuses a malformed claim capability and a Host that remains unclaimed", async () => {
    let localBootstrapReads = 0;
    const control = new NativePersonalHostControl({
      fetch: async (_deploymentId, input) => {
        const request = new Request(input);
        if (request.url.endsWith("/v1/rpc/auth.setup.claim")) return ownerClaimRpcData();
        localBootstrapReads += 1;
        return json({
          runnerEnrollmentToken: "runner-enrollment-token-12345",
          setupUrl: `${hostOrigin}/setup#token=${"a".repeat(43)}`,
        });
      },
    });
    await expect(
      control.bootstrap(
        "http://127.0.0.1:4310",
        manifest(),
        "too-short",
        new AbortController().signal,
      ),
    ).rejects.toThrow(/claim capability/u);
    await expect(
      control.bootstrap(
        "http://127.0.0.1:4310",
        manifest(),
        "a".repeat(43),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/passwordless local owner/u);
    expect(localBootstrapReads).toBe(2);
  });

  it("waits for the exact persisted Runner instead of a stale environment attachment", async () => {
    const deployment = manifest();
    let requests = 0;
    const control = new NativePersonalHostControl({
      fetch: async (_deploymentId, input) => {
        requests += 1;
        expect(new Request(input).url).toBe(bootstrapUrl);
        return rpcData(
          hostBootstrap({
            environments: [
              environment(
                deployment.environmentId,
                requests === 1 ? createId("runner") : deployment.runnerId,
              ),
            ],
          }),
        );
      },
      pollIntervalMs: 1,
      requestTimeoutMs: 1_000,
    });

    await expect(
      control.waitForRunner(
        hostOrigin,
        deployment.deploymentId,
        deployment.environmentId,
        deployment.runnerId,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(requests).toBe(2);
  });

  it("polls until this deployment's own Runner advertises the Browser placement", async () => {
    let requests = 0;
    const deployment = manifest();
    const control = new NativePersonalHostControl({
      fetch: async () => {
        requests += 1;
        return rpcData(
          hostBootstrap({
            placements: [
              // Another computer with the same runtime id but no binding to
              // this deployment's work location must never satisfy readiness.
              runnerPlacement("desktop-browser", []),
              ...(requests > 1
                ? [runnerPlacement("desktop-browser", [deployment.environmentId])]
                : []),
            ],
          }),
        );
      },
      pollIntervalMs: 1,
      requestTimeoutMs: 1_000,
    });

    await expect(
      control.waitForBrowserPlacement(
        hostOrigin,
        deployment.deploymentId,
        deployment.environmentId,
        "desktop-browser",
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(requests).toBe(2);
  });

  it("aborts Browser placement polling without another request", async () => {
    const abort = new AbortController();
    let requests = 0;
    const control = new NativePersonalHostControl({
      fetch: async () => {
        requests += 1;
        abort.abort(new Error("Personal setup cancelled"));
        return rpcData(hostBootstrap());
      },
      pollIntervalMs: 1,
    });

    const deployment = manifest();
    await expect(
      control.waitForBrowserPlacement(
        hostOrigin,
        deployment.deploymentId,
        deployment.environmentId,
        "desktop-browser",
        abort.signal,
      ),
    ).rejects.toThrow("Personal setup cancelled");
    expect(requests).toBe(1);
  });

  it("calls the messaging service ready only once it says its Host connection authenticated", async () => {
    const messagingOrigin = "http://127.0.0.1:5410";
    const requests: Request[] = [];
    const answers = [
      new Response(null, { status: 503 }),
      json({ hostAuthenticated: false, ok: false }, 503),
      json({ hostAuthenticated: false, ok: false }),
      json({ hostAuthenticated: true, ok: true }),
    ];
    const control = new NativePersonalHostControl({
      fetch: async (_deploymentId, input, init) => {
        requests.push(new Request(input, init));
        return answers.shift() ?? json({ hostAuthenticated: true, ok: true });
      },
      pollIntervalMs: 1,
    });

    await expect(
      control.waitForMessaging(
        messagingOrigin,
        manifest().deploymentId,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    // A 200 that says the Host is not authenticated is still not readiness.
    expect(requests).toHaveLength(4);
    expect(requests.map(({ url }) => url)).toEqual(
      Array.from({ length: 4 }, () => `${messagingOrigin}/readyz`),
    );
    expect(requests[0]?.credentials).toBe("omit");
  });

  it("ends the messaging readiness poll when startup is cancelled", async () => {
    const abort = new AbortController();
    let requests = 0;
    const control = new NativePersonalHostControl({
      fetch: async () => {
        requests += 1;
        abort.abort(new Error("Personal setup cancelled"));
        return json({ hostAuthenticated: false, ok: false }, 503);
      },
      pollIntervalMs: 1,
    });

    await expect(
      control.waitForMessaging("http://127.0.0.1:5410", manifest().deploymentId, abort.signal),
    ).rejects.toThrow("Personal setup cancelled");
    expect(requests).toBe(1);
  });
});

describe("NativePersonalRemoteHostControl Account-link failures", () => {
  const runtime = testPersonalHostRuntime({
    discovery: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        kind: "personal" as const,
      },
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: "2026-08-20T12:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 1,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
  const consumeInput = {
    challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
    schemaVersion: 2,
    resultExpiresAt: new Date().toISOString(),
    sealedCompletion: {
      version: 1,
      ciphertext: "abc",
      ephemeralPublicKey: "k".repeat(43),
      nonce: "n".repeat(16),
      tag: "t".repeat(22),
    },
    linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
  } as const;
  const control = (body: unknown, status: number) =>
    new NativePersonalRemoteHostControl({ fetch: async () => json(body, status) });
  const refusal = (reason: string, status: number) =>
    control({ error: { code: "conflict", message: "reworded prose", reason } }, status);

  it("obtains tunnel credentials only through the supervisor capability without session cookies", async () => {
    const capability = "Bearer local-process-capability";
    const credential = {
      canonicalOrigin: runtime.discovery.canonicalOrigin,
      deploymentId: runtime.discovery.deploymentId,
      connectorCredentialGeneration: 1,
      hostInstanceId: runtime.discovery.hostInstanceId,
      hostKeyFingerprint: hostKeyFingerprint(runtime.discoveryEnvelope.publicKey.spki),
      routeOrigin: "https://personal.connect.opensteer.test",
      tunnelToken: "tunnel-token".padEnd(43, "x"),
    };
    const requests: Request[] = [];
    const host = new NativePersonalRemoteHostControl({
      executorAuthorization: () => capability,
      fetch: async (_deploymentId, input, init) => {
        requests.push(new Request(input, init));
        return json(credential);
      },
    });
    for (const rotate of [false, true]) {
      await expect(
        host.connectCredential(
          runtime,
          {
            hostInstanceId: runtime.discovery.hostInstanceId,
            operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
            ...(rotate ? {} : { localOrigin: runtime.localOrigin }),
          },
          rotate,
        ),
      ).resolves.toEqual(credential);
    }
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/personal-remote-access/executor/connect-provision",
      "/v1/personal-remote-access/executor/connect-rotate",
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe(capability);
      expect(request.credentials).toBe("omit");
      expect(statesApiVersion(Object.fromEntries(request.headers), "personal")).toBe(true);
    }
  });

  it("maps a rejected grant to the refreshable recovery and nothing else to it", async () => {
    await expect(
      refusal("personal-account-link-grant-expired", 403).consumeAccountLink(runtime, consumeInput),
    ).rejects.toMatchObject({ code: "personal-account-link-completion-grant-rejected" });
  });

  it.each([
    "personal-account-link-reservation-expired",
    "personal-account-link-cancelled",
  ] as const)("surfaces %s as an actionable dead end on consume and resume", async (reason) => {
    await expect(
      refusal(reason, 409).consumeAccountLink(runtime, consumeInput),
    ).rejects.toMatchObject({ code: reason, name: "PersonalAccountLinkReservationLostError" });
    await expect(refusal(reason, 409).resumeAccountLink(runtime)).rejects.toMatchObject({
      code: reason,
      // The message names the move the owner has, since no refresh can help.
      message: expect.stringContaining("Unlink this Opensteer"),
    });
  });

  it("passes on the Host's own refusal and keeps an internal fault's message out", async () => {
    await expect(
      control({ error: { code: "conflict", message: "Already linked." } }, 409).consumeAccountLink(
        runtime,
        consumeInput,
      ),
    ).rejects.toThrow(new PersonalHostRefusalError("Already linked.", 409));
    const internal = control({ error: { code: "internal", message: "boom" } }, 500)
      .consumeAccountLink(runtime, consumeInput)
      .catch((error: unknown) => error);
    await expect(internal).resolves.not.toBeInstanceOf(PersonalHostRefusalError);
    await expect(internal).resolves.toMatchObject({ message: "Account-link completion failed." });
  });
});

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "content-type": "application/json" }, status });
}

/** Success envelope exactly as the Host's rpc registration writes it. */
function rpcData(data: unknown): Response {
  return json({ data: hostApi["bootstrap.get"].success.parse(data), ok: true });
}

function ownerClaimRpcData(): Response {
  return json({
    data: hostApi["auth.setup.claim"].success.parse({ session: authenticatedSession() }),
    ok: true,
  });
}

function rpcError(error: { readonly code: string; readonly message: string }, status: number) {
  return json({ error: { ...error, retryable: status >= 500 }, ok: false }, status);
}

/**
 * A complete bootstrap, parsed by the declaration the Desktop reads it with, so
 * a fixture can never drift into describing a Host that could not exist.
 */
function hostBootstrap(
  overrides: {
    readonly environments?: readonly unknown[];
    readonly placements?: readonly unknown[];
  } = {},
) {
  return {
    deploymentId: createId("deployment"),
    sessionId: createId("authSession"),
    personalSettings: {
      ownerId: createId("user"),
      agentHome: { computerId: createId("runner"), path: "/Users/test/Opensteer" },
      voiceThreadId: null,
    },
    can: { createTasks: true, useVoice: true, manageComputers: true, managePrivateResources: true },
    appTabs: [],
    browser: {
      available: true,
      placements: overrides.placements ?? [],
      profileGrants: [],
      profiles: [],
      groups: { rows: [], complete: true },
      tabs: [],
    },
    environments: overrides.environments ?? [],
    executionPreferences: { accessMode: "full-access", history: [] },
    quietTaskDays: 7,
    harnesses: [],
    latestPlaces: [],
    sessionSurface: "canonical",
    identityConfig: {
      deployment: { kind: "personal" as const, name: "This computer" },
      emailDeliveryAvailable: false,
      exposure: "loopback",
      localPasswordEnabled: false,
      machineOwner: true,
      oidcProviders: [],
      passkeysEnabled: false,
      portalOrigin: null,
      publicOrigin: hostOrigin,
      setupState: "complete",
      signupPolicy: "closed",
    },
    machines: [],
    user: authenticatedSession().user,
  };
}

function environment(id: EnvironmentId, runnerId: RunnerId) {
  return {
    capabilities: [],
    connected: true,
    harnessAuthenticationAllowed: true,
    harnessCatalogs: [],
    harnessDrivers: [],
    id,
    kind: "main",
    name: "This computer",
    providerStateModes: [],
    runnerId,
    status: "connected",
    can: { executeTasks: true },
  };
}

function runnerPlacement(runtimeId: string, environmentIds: readonly EnvironmentId[]) {
  return {
    available: true,
    environmentIds: [...environmentIds],
    kind: "runner",
    label: "This computer",
    runnerId: createId("runner"),
    runtimeId,
  };
}

function authenticatedSession() {
  return {
    absoluteExpiresAt: "2026-08-13T12:00:00.000Z",
    createdAt: "2026-08-12T12:00:00.000Z",
    expiresAt: "2026-08-12T13:00:00.000Z",
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "You",
      email: "owner@personal.opensteer.local",
      emailVerified: true,
      id: createId("user"),
      image: null,
      instanceRole: "administrator",
    },
  };
}

function manifest(): PersonalDeploymentManifest {
  return {
    createdAt: "2026-08-12T12:00:00.000Z",
    databaseInitialized: true,
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
    hostPort: 4310,
    name: "This computer",
    ownerInitialized: true,
    postgresPort: 5432,
    release: {
      architecture: "arm64",
      hostVersion: "1.2.3",
      manifestSha256: "a".repeat(64),
      operatingSystem: "darwin",
      postgresMajor: 17,
      postgresVersion: "17.4.0",
      runnerVersion: "2.3.4",
    },
    revision: 3,
    runnerId: createId("runner"),
    schemaVersion: 3,
    setupIntentId: "019ff6c2-309a-7380-9093-e126eb2bda4b",
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}
