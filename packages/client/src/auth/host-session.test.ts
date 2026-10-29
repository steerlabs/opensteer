import { createId } from "@opensteer/core";
import type { SessionExchangeResponse } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { establishedCookieSession, testDiscoveryEnvelope } from "../test-support/index.js";
import {
  DeploymentConnectionSchema,
  type AccountDeploymentConnectionSource,
  type DeploymentCatalog,
  type DeploymentConnection,
} from "../connections/deployment-catalog.js";
import {
  resolveConnection,
  type LocalHostRuntime,
  type ResolvedConnection,
} from "../connections/connection-resolver.js";
import { credentialKindFor, HostSessionExchangeError } from "./host-session-exchange.js";
import {
  AccountBrokeredHostSessions,
  HostSession,
  type SelectedAttachment,
} from "./host-session.js";
import type { HostOAuthState } from "./native-oauth.js";

describe("HostSession", () => {
  it("trusts only the exact ready local-owner generation and coalesces 401 recovery", async () => {
    const connection = localPersonalConnection();
    const fixture = hostSessionFixture(connection, localHostRuntime(connection));
    fixture.local.ownsHostSession.mockReturnValue(true);
    const gate = deferred<SessionExchangeResponse>();
    fixture.local.recoverOwnerSession.mockImplementation(async () => {
      await gate.promise;
      return true;
    });

    await expect(
      fixture.sessions.establish(connection.authority.document.deploymentId),
    ).resolves.toMatchObject({
      attachmentKey: fixture.attachment.resolved.key,
      outcome: "ready",
    });
    expect(fixture.exchange.probe).not.toHaveBeenCalled();
    expect(fixture.exchange.probe).not.toHaveBeenCalled();
    expect(fixture.oauth.beginHostSignIn).not.toHaveBeenCalled();

    const recoveries = [
      fixture.sessions.recoverUnauthorized(fixture.attachment),
      fixture.sessions.recoverUnauthorized(fixture.attachment),
      fixture.sessions.recoverUnauthorized(fixture.attachment),
    ];
    gate.resolve(establishedCookieSession());
    await expect(Promise.all(recoveries)).resolves.toEqual(["recovered", "recovered", "recovered"]);
    expect(fixture.local.recoverOwnerSession).toHaveBeenCalledOnce();
  });

  it("uses an existing Connect Host session without spending another Account grant", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const fixture = hostSessionFixture(connection);
    fixture.exchange.probe.mockResolvedValue("authenticated");

    await expect(
      fixture.sessions.establish(connection.authority.document.deploymentId),
    ).resolves.toMatchObject({
      outcome: "ready",
    });

    expect(fixture.exchange.establish).not.toHaveBeenCalled();
    expect(fixture.accountCredentialRejected).not.toHaveBeenCalled();
  });

  it("shares one Host mutation between concurrent establishment and 401 recovery", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const fixture = hostSessionFixture(connection);
    fixture.exchange.probe.mockResolvedValue("unauthenticated");
    const gate = deferred<SessionExchangeResponse>();
    fixture.exchange.establish.mockImplementation(() => gate.promise);

    const establishment = fixture.sessions.establish(connection.authority.document.deploymentId);
    await vi.waitFor(() => expect(fixture.exchange.establish).toHaveBeenCalledOnce());
    const recovery = fixture.sessions.recoverUnauthorized(fixture.attachment);
    gate.resolve(establishedCookieSession());

    await expect(establishment).resolves.toMatchObject({ outcome: "ready" });
    await expect(recovery).resolves.toBe("recovered");
    expect(fixture.exchange.establish).toHaveBeenCalledOnce();
  });

  it("lets establishment join an already-running 401 recovery without another grant", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const fixture = hostSessionFixture(connection);
    const gate = deferred<SessionExchangeResponse>();
    fixture.exchange.establish.mockImplementation(() => gate.promise);

    const recovery = fixture.sessions.recoverUnauthorized(fixture.attachment);
    await vi.waitFor(() => expect(fixture.exchange.establish).toHaveBeenCalledOnce());
    const establishment = fixture.sessions.establish(connection.authority.document.deploymentId);
    gate.resolve(establishedCookieSession());

    await expect(recovery).resolves.toBe("recovered");
    await expect(establishment).resolves.toMatchObject({ outcome: "ready" });
    expect(fixture.exchange.establish).toHaveBeenCalledOnce();
  });

  it("redeems a Connect grant only after a 401 and keeps network failure unavailable", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const fixture = hostSessionFixture(connection);
    fixture.exchange.probe.mockResolvedValueOnce("unauthenticated");

    await expect(
      fixture.sessions.establish(connection.authority.document.deploymentId),
    ).resolves.toMatchObject({
      outcome: "ready",
    });
    expect(fixture.exchange.establish).toHaveBeenCalledOnce();

    const offline = hostSessionFixture(connection);
    offline.exchange.probe.mockRejectedValue(new TypeError("network offline"));
    await expect(
      offline.sessions.establish(connection.authority.document.deploymentId),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(offline.exchange.establish).not.toHaveBeenCalled();
    expect(offline.accountCredentialRejected).not.toHaveBeenCalled();
  });

  it("drives every remote Personal route through the one session-exchange contract", async () => {
    const connect = remotePersonalConnection("connect", 7);
    const connectFixture = hostSessionFixture(connect);
    connectFixture.exchange.probe.mockResolvedValue("unauthenticated");
    await expect(
      connectFixture.sessions.establish(connect.authority.document.deploymentId),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(connectFixture.exchange.establish).toHaveBeenCalledWith(
      connectFixture.attachment.resolved,
    );

    // A Private route carries a proof only the operator holds, so an unattended
    // exchange reports that rather than inventing one.
    const privateConnection = remotePersonalConnection("private", 4);
    const privateFixture = hostSessionFixture(privateConnection);
    privateFixture.exchange.probe.mockResolvedValue("unauthenticated");
    privateFixture.exchange.establish.mockImplementation(async (_connection, options) => {
      if (options?.pairingCode === undefined) {
        throw new HostSessionExchangeError("pairing-required", "Enter a new pairing code.");
      }
      return establishedCookieSession();
    });
    await expect(
      privateFixture.sessions.establish(privateConnection.authority.document.deploymentId),
    ).resolves.toMatchObject({ outcome: "needs-sign-in" });
    await expect(
      privateFixture.sessions.recoverUnauthorized(privateFixture.attachment),
    ).resolves.toBe("pairing-required");
  });

  it("reports Host admission the same way for every exchanged attachment", async () => {
    for (const connection of [
      remotePersonalConnection("connect", 1),
      remotePersonalConnection("connect", 2),
    ]) {
      const fixture = hostSessionFixture(connection);
      fixture.exchange.probe.mockResolvedValue("blocked");
      await expect(
        fixture.sessions.establish(connection.authority.document.deploymentId),
      ).resolves.toMatchObject({ outcome: "blocked" });
      expect(fixture.exchange.establish).not.toHaveBeenCalled();
    }
  });

  it("starts Host-native OAuth only for self-hosted attachments and publishes its exact key", async () => {
    const connection = connectionOfKind("self-hosted");
    const fixture = hostSessionFixture(connection);
    const observations: unknown[] = [];
    fixture.sessions.subscribe((observation) => observations.push(observation));

    await expect(
      fixture.sessions.establish(connection.authority.document.deploymentId),
    ).resolves.toMatchObject({
      outcome: "authorizing",
    });
    expect(fixture.oauth.beginHostSignIn).toHaveBeenCalledWith(connection);

    fixture.oauth.emit(connection, "signed-in");
    await vi.waitFor(() =>
      expect(observations).toContainEqual(
        expect.objectContaining({
          attachmentKey: fixture.attachment.resolved.key,
          outcome: "ready",
        }),
      ),
    );
  });

  it("abandons an in-flight Host sign-in and lets a fresh attempt replace it", async () => {
    const connection = connectionOfKind("self-hosted");
    const fixture = hostSessionFixture(connection);
    const first = deferred<HostOAuthState>();
    fixture.oauth.beginHostSignIn.mockImplementationOnce(() => first.promise);
    const observations: unknown[] = [];
    fixture.sessions.subscribe((observation) => observations.push(observation));

    const abandoned = fixture.sessions.establish(connection.authority.document.deploymentId);
    await vi.waitFor(() => expect(fixture.oauth.beginHostSignIn).toHaveBeenCalledOnce());
    fixture.sessions.abandonAuthorization(connection.authority.document.deploymentId);
    const replacement = fixture.sessions.establish(connection.authority.document.deploymentId);

    await expect(replacement).resolves.toMatchObject({ outcome: "authorizing" });
    first.resolve({
      connection,
      detail: "Complete authorization in your browser.",
      key: keyOf(connection),
      status: "authorizing",
    });
    await expect(abandoned).resolves.toMatchObject({ outcome: "authorizing" });
    expect(fixture.oauth.beginHostSignIn).toHaveBeenCalledTimes(2);
    expect(fixture.oauth.abandonHostSignIn).toHaveBeenCalledWith(
      connection.authority.document.deploymentId,
    );
    expect(observations).toHaveLength(1);
  });

  it("rejects late results after the selected route generation changes", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const changed = remotePersonalConnection("connect", 8);
    const fixture = hostSessionFixture(connection);
    fixture.exchange.probe.mockResolvedValue("unauthenticated");
    const gate = deferred<SessionExchangeResponse>();
    fixture.exchange.establish.mockImplementation(() => gate.promise);
    const observations: unknown[] = [];
    fixture.sessions.subscribe((observation) => observations.push(observation));

    const establishment = fixture.sessions.establish(connection.authority.document.deploymentId);
    await vi.waitFor(() => expect(fixture.exchange.establish).toHaveBeenCalledOnce());
    fixture.selection.current = attachmentFor(changed);
    gate.resolve(establishedCookieSession());

    await expect(establishment).rejects.toThrow(/connection changed/u);
    expect(observations).toEqual([]);
  });

  it("never retries a request after recovery completed for a stale attachment", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const changed = remotePersonalConnection("connect", 8);
    const fixture = hostSessionFixture(connection);
    const gate = deferred<SessionExchangeResponse>();
    fixture.exchange.establish.mockImplementation(() => gate.promise);

    const recovery = fixture.sessions.recoverUnauthorized(fixture.attachment);
    await vi.waitFor(() => expect(fixture.exchange.establish).toHaveBeenCalledOnce());
    fixture.selection.current = attachmentFor(changed);
    gate.resolve(establishedCookieSession());

    await expect(recovery).resolves.toBe("unavailable");
  });

  it("derives Account-brokered cleanup from the durable catalog after restart", async () => {
    const source = {
      issuer: "https://account.opensteer.test",
      kind: "account" as const,
      subject: "acct_test",
    } as AccountDeploymentConnectionSource;
    const connect = {
      ...remotePersonalConnection("connect", 1),
      source,
    } as DeploymentConnection;
    const privateConnection = {
      ...remotePersonalConnection("private", 1),
      source,
    } as DeploymentConnection;
    const selfHosted = connectionOfKind("self-hosted");
    const deployments = [connect, privateConnection, selfHosted];
    const clearDeploymentSession = vi.fn(async (_deploymentId: string) => undefined);
    const removeAccountDeployments = vi.fn(async () => catalogFor(selfHosted, [selfHosted]));
    const brokered = new AccountBrokeredHostSessions({
      catalog: {
        load: async () => catalogFor(connect, deployments),
        removeAccountDeployments,
      },
      clearDeploymentSession,
    });
    const clearedEvents: Array<readonly string[]> = [];
    brokered.subscribe((deploymentIds) => clearedEvents.push(deploymentIds));

    await brokered.removeAllAccountIdentities();

    expect(clearDeploymentSession.mock.calls.map(([deploymentId]) => deploymentId)).toEqual([
      connect.authority.document.deploymentId,
    ]);
    expect(removeAccountDeployments).toHaveBeenCalledWith(source);
    expect(clearedEvents).toEqual([[connect.authority.document.deploymentId]]);
  });

  it("surfaces an Account grant rejection on Account state, not as Host-native OAuth", async () => {
    const connection = remotePersonalConnection("connect", 7);
    const fixture = hostSessionFixture(connection);
    fixture.exchange.probe.mockResolvedValue("unauthenticated");
    fixture.exchange.establish.mockRejectedValue(
      new HostSessionExchangeError("account-required", "Account credential expired."),
    );

    await expect(
      fixture.sessions.establish(connection.authority.document.deploymentId),
    ).resolves.toMatchObject({
      outcome: "needs-sign-in",
    });
    expect(fixture.accountCredentialRejected).toHaveBeenCalledOnce();
    expect(fixture.oauth.beginHostSignIn).not.toHaveBeenCalled();
  });
});

function hostSessionFixture(
  selected: DeploymentConnection,
  localRuntime: LocalHostRuntime | null = null,
) {
  const selection = { current: attachmentFor(selected, localRuntime) };
  // `supports` is the real arm selection so the fixture cannot claim an
  // attachment exchanges a credential when the contract says it does not.
  const exchange = {
    establish: vi.fn<
      (
        _resolved: ResolvedConnection,
        _options?: { readonly pairingCode?: string },
      ) => Promise<SessionExchangeResponse>
    >(async () => establishedCookieSession()),
    probe: vi.fn<
      (_resolved: ResolvedConnection) => Promise<"authenticated" | "blocked" | "unauthenticated">
    >(async () => "authenticated"),
    supports: (resolved: ResolvedConnection) =>
      credentialKindFor(resolved.access, resolved.bootstrapMethods) !== null,
  };
  const local = {
    ownsHostSession: vi.fn(() => false),
    recoverOwnerSession: vi.fn(async () => false),
  };
  const listeners = new Set<(state: never) => void>();
  const oauthStatus = {
    current: "signed-out" as "authorizing" | "error" | "signed-in" | "signed-out",
  };
  const oauth = {
    abandonHostSignIn: vi.fn((_deploymentId: string) => undefined),
    beginHostSignIn: vi.fn<(connection: DeploymentConnection) => Promise<HostOAuthState>>(
      async (connection) => {
        oauthStatus.current = "authorizing";
        return {
          connection,
          detail: "Complete authorization in your browser.",
          key: keyOf(connection),
          status: "authorizing" as const,
        };
      },
    ),
    emit(connection: DeploymentConnection, status: typeof oauthStatus.current) {
      oauthStatus.current = status;
      for (const listener of listeners) {
        listener({ connection, detail: null, key: keyOf(connection), status } as never);
      }
    },
    hostCredentialState: vi.fn((connection: DeploymentConnection) => ({
      connection,
      detail: null,
      key: keyOf(connection),
      status: oauthStatus.current,
    })),
    recoverHostAuthorization: vi.fn(async () => true),
    signOutHost: vi.fn(async (connection: DeploymentConnection) => ({
      connection,
      detail: null,
      key: keyOf(connection),
      status: "signed-out" as const,
    })),
    subscribeHostCredentials: vi.fn((listener: (state: never) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const accountCredentialRejected = vi.fn(async () => undefined);
  const clearDeploymentSession = vi.fn(async (_deploymentId: string) => undefined);
  const sessions = new HostSession({
    accountCredentialRejected,
    attachment: {
      current: async () => selection.current,
      currentKey: () => selection.current.resolved.key,
    },
    clearDeploymentSession,
    exchange,
    localOwner: local,
    oauth,
  });
  return {
    accountCredentialRejected,
    attachment: selection.current,
    clearDeploymentSession,
    exchange,
    local,
    oauth,
    selection,
    sessions,
  };
}

function attachmentFor(
  connection: DeploymentConnection,
  localRuntime: LocalHostRuntime | null = null,
): SelectedAttachment {
  return {
    connection,
    resolved: resolveConnection(connection, localRuntime, { authorization: null }),
  };
}

function keyOf(connection: DeploymentConnection): string {
  return resolveConnection(connection, null, { authorization: null }).key;
}

function localHostRuntime(connection: DeploymentConnection): LocalHostRuntime {
  return {
    authority: connection.authority,
    localOrigin: connection.authority.document.canonicalOrigin,
  };
}

function connectionOfKind(kind: "self-hosted"): DeploymentConnection {
  const origin = `https://${kind}.opensteer.test`;
  return DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin: origin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    }),
    bootstrapMethods: ["password"],
    createdAt: "2026-08-22T10:00:00.000Z",
    endpoints: [{ kind: "canonical", origin, verifiedAt: "2026-08-22T10:00:00.000Z" }],
    kind,
    lastUsedAt: null,
    name: kind,
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: "2026-08-22T10:00:00.000Z",
  });
}

function localPersonalConnection(): DeploymentConnection {
  const base = connectionOfKind("self-hosted");
  const origin = "http://127.0.0.1:4310";
  return DeploymentConnectionSchema.parse({
    ...base,
    authority: testDiscoveryEnvelope({
      ...base.authority.document,
      canonicalOrigin: origin,
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    }),
    endpoints: [{ kind: "canonical", origin, verifiedAt: "2026-08-22T10:00:00.000Z" }],
    kind: "personal" as const,
  });
}

function remotePersonalConnection(
  routeKind: "connect" | "private",
  generation: number,
): DeploymentConnection {
  const local = localPersonalConnection();
  const origin = `https://${routeKind}-${generation}.personal.opensteer.test`;
  return {
    ...local,
    accountLivenessExpiresAt: null,
    bootstrapMethods: [routeKind === "connect" ? "connect-grant" : "pairing-code"],
    endpoints: [{ kind: "direct", origin, verifiedAt: "2026-08-22T10:00:00.000Z" }],
    personalAccessRoute: {
      document: {
        route: { generation, kind: routeKind, origin },
      },
    } as never,
    preferredEndpointOrigin: origin,
    reachability: "routed",
  } as DeploymentConnection;
}

function catalogFor(
  selected: DeploymentConnection,
  deployments: readonly DeploymentConnection[] = [selected],
): DeploymentCatalog {
  return {
    deployments: [...deployments],
    revision: 1,
    schemaVersion: 4,
    selectedDeploymentId: selected.authority.document.deploymentId,
    updatedAt: "2026-08-22T10:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
