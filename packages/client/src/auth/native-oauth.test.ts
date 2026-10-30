import { sha256 } from "@noble/hashes/sha2.js";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { createId, opensteerAccountOAuthScopes } from "@opensteer/core";
import {
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentConnectionSchema,
  type AccountDeploymentConnectionSource,
  type DeploymentCatalog,
  type DeploymentConnection,
} from "../connections/deployment-catalog.js";
import {
  MemoryProtectedAuthStore,
  signTestDiscoveryEnvelope,
  testHostAuthorityKeys,
} from "../test-support/index.js";
import { NativeOAuthManager } from "./native-oauth.js";
import type { ProtectedAuthStore } from "./protected-auth-store.js";

describe("NativeOAuthManager", () => {
  it("rotates saved-view login IDs on code exchange and preserves them on refresh", async () => {
    const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    const login = async () => {
      await fixture.manager.beginHostSignIn(fixture.connection);
      await fixture.manager.handleCallback(
        callbackUrl(
          "host",
          new URL(fixture.opened.at(-1)!).searchParams.get("state")!,
          "host-code",
        ),
      );
    };
    await login();
    const first = (await fixture.store.load()).hosts[0]?.viewLoginId;
    expect(first).toEqual(expect.any(String));
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");
    await fixture.manager.authorizationHeader(fixture.connection);
    expect((await fixture.store.load()).hosts[0]?.viewLoginId).toBe(first);
    await login();
    expect((await fixture.store.load()).hosts[0]?.viewLoginId).not.toBe(first);
    await fixture.signInAccount();
    const account = (await fixture.store.load()).account?.viewLoginId;
    expect(account).toEqual(expect.any(String));
    await fixture.signInAccount();
    expect((await fixture.store.load()).account?.viewLoginId).not.toBe(account);
    fixture.manager.dispose();
  });

  it("initializes legacy login IDs only while the confirmed bootstrap still owns the credential", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    await fixture.manager.handleCallback(
      callbackUrl("host", new URL(fixture.opened.at(-1)!).searchParams.get("state")!, "host-code"),
    );
    const credential = (await fixture.store.load()).hosts[0]!;
    const { viewLoginId: _id, ...legacy } = credential;
    await fixture.store.setHost(legacy);
    fixture.manager.dispose();
    // Reopen the owner over the persisted legacy record.
    const owner = new NativeOAuthManager({
      accountOrigin: null,
      accountSessions: fixture.accountSessions,
      catalog: fixture.catalog,
      oauth: {
        application: "desktop",
        clientId: "opensteer-desktop",
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
      openExternal: async () => undefined,
      store: fixture.store,
    });
    await owner.initialize();
    expect(owner.hostViewLoginId(fixture.connection)).toBeUndefined();
    const started = deferred<void>(),
      release = deferred<void>();
    const setHost = fixture.store.setHost.bind(fixture.store);
    vi.spyOn(fixture.store, "setHost").mockImplementationOnce(async (value) => {
      started.resolve();
      await release.promise;
      return setHost(value);
    });
    let current = true;
    const initializing = owner.initializeViewLoginIds(fixture.connection, () => current);
    await started.promise;
    current = false;
    release.resolve();
    await initializing;
    expect(owner.hostViewLoginId(fixture.connection)).toBeUndefined();
    await owner.initializeViewLoginIds(fixture.connection, () => true);
    expect(owner.hostViewLoginId(fixture.connection)).toEqual(expect.any(String));
    const write = vi.spyOn(fixture.store, "setHost").mockClear();
    await owner.initializeViewLoginIds(fixture.connection, () => true);
    expect(write).not.toHaveBeenCalled();
    owner.dispose();
  });

  it("opens Account and Host consent in the system browser with S256 PKCE", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();

    await expect(fixture.manager.beginAccountSignIn()).resolves.toMatchObject({
      account: { status: "authorizing" },
    });
    const accountAuthorize = new URL(fixture.opened[0]!);
    expect(`${accountAuthorize.origin}${accountAuthorize.pathname}`).toBe(
      "https://accounts.opensteer.test/api/auth/oauth2/authorize",
    );
    expect(accountAuthorize.searchParams.get("client_id")).toBe("opensteer-desktop");
    expect(accountAuthorize.searchParams.get("redirect_uri")).toBe(
      "com.opensteer.opensteer:/oauth/account-callback",
    );
    expect(accountAuthorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(accountAuthorize.searchParams.get("scope")?.split(" ")).toContain("email");
    expect(accountAuthorize.searchParams.get("prompt")).toBe("login");
    await fixture.manager.handleCallback(
      callbackUrl("account", accountAuthorize.searchParams.get("state")!, "account-code"),
    );
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: {
        identity: { email: "alex@opensteer.test", subject: fixture.accountSubject.current },
        status: "signed-in",
      },
    });

    await expect(fixture.manager.beginHostSignIn(fixture.connection)).resolves.toMatchObject({
      status: "authorizing",
    });
    const hostAuthorize = new URL(fixture.opened[1]!);
    expect(`${hostAuthorize.origin}${hostAuthorize.pathname}`).toBe(
      "https://host.opensteer.test/v1/auth/native/oauth2/authorize",
    );
    expect(hostAuthorize.searchParams.get("redirect_uri")).toBe(
      "com.opensteer.opensteer:/oauth/host-callback",
    );
    await fixture.manager.handleCallback(
      callbackUrl("host", hostAuthorize.searchParams.get("state")!, "host-code"),
    );
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toMatch(
      /^Bearer host-access-/u,
    );

    for (const exchange of fixture.exchanges) {
      const verifier = exchange.form.get("code_verifier")!;
      const authorization = fixture.opened.find((url) =>
        url.includes(exchange.form.get("redirect_uri")!.split("/").at(-1)!),
      );
      expect(encodeBase64Url(sha256(new TextEncoder().encode(verifier)))).toBe(
        new URL(authorization!).searchParams.get("code_challenge"),
      );
    }
  });

  it("keeps Host-native sign-in working with no Account issuer or traffic", async () => {
    const fixture = await managerFixture({ accountOrigin: null });
    await fixture.manager.initialize();
    expect(await fixture.manager.state()).toMatchObject({
      account: { available: false, status: "signed-out" },
    });
    await expect(fixture.manager.beginAccountSignIn()).rejects.toThrow(/isn't available yet/u);
    await expect(fixture.manager.beginAccountReauthorization()).rejects.toThrow(
      /isn't available yet/u,
    );
    expect(fixture.opened).toEqual([]);
    expect(fixture.exchanges).toEqual([]);
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    expect(
      fixture.opened.every((url) => new URL(url).origin === "https://host.opensteer.test"),
    ).toBe(true);
    expect(fixture.exchanges.map(({ url }) => new URL(url).origin)).toEqual([
      "https://host.opensteer.test",
    ]);
    expect(fixture.refreshes).toEqual([]);
  });

  it("requests an explicit fresh Account session without replaying an Account mutation", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await expect(fixture.manager.beginAccountReauthorization()).rejects.toThrow(
      /Sign in.*before verifying/u,
    );

    await fixture.manager.beginAccountSignIn();
    const initial = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("account", initial.searchParams.get("state")!, "account-code"),
    );
    await expect(fixture.manager.beginAccountReauthorization()).resolves.toMatchObject({
      account: { status: "authorizing" },
    });

    const reauthorization = new URL(fixture.opened[1]!);
    expect(reauthorization.searchParams.get("prompt")).toBe("login");
    expect(reauthorization.searchParams.get("max_age")).toBe("0");
    expect(reauthorization.searchParams.get("state")).not.toBe(initial.searchParams.get("state"));
    await fixture.manager.handleCallback(
      callbackUrl(
        "account",
        reauthorization.searchParams.get("state")!,
        "account-reauthorization-code",
      ),
    );

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: null, status: "signed-in" },
    });
    await vi.waitFor(() => expect(fixture.revocations).toHaveLength(1));
    expect(fixture.revocations[0]?.form.get("token")).toMatch(/^account-refresh-1-/u);
    expect(fixture.exchanges).toHaveLength(2);
  });

  it("never publishes Host state while Account credentials authorize or refresh", async () => {
    const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    const hostEvents: unknown[] = [];
    fixture.manager.subscribeHostCredentials((state) => hostEvents.push(state));

    await fixture.manager.beginAccountSignIn();
    const accountAuthorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("account", accountAuthorize.searchParams.get("state")!, "account-code"),
    );
    expect(hostEvents).toEqual([]);

    await fixture.manager.beginHostSignIn(fixture.connection);
    const hostAuthorize = new URL(fixture.opened[1]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", hostAuthorize.searchParams.get("state")!, "host-code"),
    );
    expect(hostEvents).not.toEqual([]);
    hostEvents.length = 0;

    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");
    await fixture.manager.accountAuthorizationHeader();
    expect(hostEvents).toEqual([]);
    await expect(fixture.manager.state()).resolves.toEqual({
      account: {
        available: true,
        detail: null,
        identity: {
          email: "alex@opensteer.test",
          issuer: "https://accounts.opensteer.test",
          subject: fixture.accountSubject.current,
        },
        status: "signed-in",
      },
      schemaVersion: 2,
    });
  });

  // A refresh that never got a verdict from the Account is not a verdict: a
  // laptop waking onto a dead network, an Account outage or a rate limit must
  // not sign a person out. Only the Account refusing the grant ends a session.
  it.each([
    ["the Account cannot be reached", { network: true }],
    ["the Account answers with a server error", { status: 503 }],
    ["the Account rate-limits the refresh", { status: 429 }],
  ] as const)("keeps the Account session when %s", async (_case, failure) => {
    const refresh = deferred<void>();
    const fixture = await managerFixture({
      refreshGate: refresh.promise,
      refreshStatuses: "status" in failure ? [failure.status, failure.status] : [],
      tokenLifetimeSeconds: 61,
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    fixture.accountSessions.removeOtherAccountIdentities.mockClear();
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const header = fixture.manager.accountAuthorizationHeader();
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1));
    if ("network" in failure) refresh.reject(new TypeError("fetch failed"));
    else refresh.resolve();

    await expect(header).rejects.toMatchObject({ classification: "transient" });
    await expect(fixture.manager.accountAuthorizationLease()).rejects.toMatchObject({
      classification: "transient",
    });
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: null, status: "signed-in" },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({
      account: { subject: fixture.accountSubject.current },
    });
    expect(fixture.accountSessions.removeAllAccountIdentities).not.toHaveBeenCalled();
    expect(fixture.accountSessions.removeOtherAccountIdentities).not.toHaveBeenCalled();
    expect(fixture.catalog.removeAccountDeployments).not.toHaveBeenCalled();
  });

  it("recovers the kept Account session on the next refresh that reaches the Account", async () => {
    const fixture = await managerFixture({ refreshStatuses: [503], tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    await expect(fixture.manager.accountAuthorizationHeader()).rejects.toMatchObject({
      classification: "transient",
    });
    await expect(fixture.manager.accountAuthorizationHeader()).resolves.toMatch(
      /^Bearer account-access-/u,
    );
    expect(fixture.refreshes).toHaveLength(2);
  });

  it("keeps the Account session when a refresh outlives the network deadline", async () => {
    const fixture = await managerFixture({
      networkTimeoutMs: 20,
      refreshGate: new Promise<void>(() => undefined),
      tokenLifetimeSeconds: 61,
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    await expect(fixture.manager.accountAuthorizationHeader()).rejects.toMatchObject({
      classification: "transient",
    });
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { status: "signed-in" },
    });
  });

  it.each([400, 401])(
    "ends the Account session, keeping cached Deployments, when the Account refuses a refresh with %i",
    async (status) => {
      const fixture = await managerFixture({ refreshStatuses: [status], tokenLifetimeSeconds: 61 });
      await fixture.manager.initialize();
      await fixture.signInAccount();
      fixture.accountSessions.removeOtherAccountIdentities.mockClear();
      fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

      await expect(fixture.manager.accountAuthorizationHeader()).resolves.toBeNull();
      await expect(fixture.manager.state()).resolves.toMatchObject({
        account: { detail: expect.stringMatching(/expired/u), status: "error" },
      });
      await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
      expect(fixture.accountSessions.removeAllAccountIdentities).not.toHaveBeenCalled();
      expect(fixture.accountSessions.removeOtherAccountIdentities).not.toHaveBeenCalled();
      expect(fixture.catalog.removeAccountDeployments).not.toHaveBeenCalled();
    },
  );

  it("keeps a Host credential when its refresh cannot reach the Host", async () => {
    const fixture = await managerFixture({ refreshStatuses: [502], tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    await expect(fixture.manager.authorizationHeader(fixture.connection)).rejects.toMatchObject({
      classification: "transient",
    });
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toMatch(
      /^Bearer host-access-/u,
    );
  });

  it("clears a Host credential the Host refuses to refresh", async () => {
    const fixture = await managerFixture({ refreshStatuses: [400], tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBeNull();
    await expect(fixture.store.load()).resolves.toMatchObject({ hosts: [] });
  });

  it("binds a consumed Host callback to the exact requested authority", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    const callback = callbackUrl("host", authorize.searchParams.get("state")!, "host-code");
    fixture.catalog.current = catalogFor(
      DeploymentConnectionSchema.parse({
        ...fixture.connection,
        authority: signDiscovery({
          ...fixture.connection.authority.document,
          hostInstanceId: createId("hostInstance"),
        }),
      }),
    );

    await expect(fixture.manager.handleCallback(callback)).resolves.toBe(true);
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    expect(fixture.exchanges).toHaveLength(1);
    await fixture.manager.handleCallback(callback);
    expect(fixture.exchanges).toHaveLength(1);
  });

  it("consumes a callback from the wrong authorization issuer without exchanging its code", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.manager.beginAccountSignIn();
    const authorize = new URL(fixture.opened[0]!);
    const callback = new URL(
      callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
    );
    callback.searchParams.set("iss", "https://attacker.example.test");

    await expect(fixture.manager.handleCallback(callback.toString())).resolves.toBe(true);
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: {
        detail: expect.stringMatching(/issuer did not match/u),
        status: "error",
      },
    });
    expect(fixture.exchanges).toHaveLength(0);
    await fixture.manager.handleCallback(callback.toString());
    expect(fixture.exchanges).toHaveLength(0);
  });

  it("serializes refresh, rotates the protected token, and clears Host OAuth on logout", async () => {
    const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const [first, second] = await Promise.all([
      fixture.manager.authorizationHeader(fixture.connection),
      fixture.manager.authorizationHeader(fixture.connection),
    ]);
    expect(first).toBe(second);
    expect(fixture.refreshes).toHaveLength(1);

    await expect(fixture.manager.signOutHost(fixture.connection)).resolves.toMatchObject({
      status: "signed-out",
    });
    expect(fixture.revocations).toHaveLength(1);
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBeNull();
  });

  it("shares a Host refresh across canonical and direct routes", async () => {
    const refresh = deferred<void>();
    const fixture = await managerFixture({
      refreshGate: refresh.promise,
      tokenLifetimeSeconds: 61,
    });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    const direct = DeploymentConnectionSchema.parse({
      ...fixture.connection,
      endpoints: [
        ...fixture.connection.endpoints,
        {
          kind: "direct",
          origin: "https://direct.opensteer.test",
          verifiedAt: "2026-08-11T19:00:00.000Z",
        },
      ],
      preferredEndpointOrigin: "https://direct.opensteer.test",
    });
    expect(fixture.manager.hostCredentialState(direct).key).not.toBe(
      fixture.manager.hostCredentialState(fixture.connection).key,
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const first = fixture.manager.authorizationHeader(fixture.connection);
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1));
    const second = fixture.manager.authorizationHeader(direct);
    refresh.resolve();

    const expected = `Bearer host-access-2-${"a".repeat(20)}`;
    await expect(first).resolves.toBe(expected);
    await expect(second).resolves.toBe(expected);
    expect(fixture.refreshes).toHaveLength(1);
  });

  it("keeps a rotated Account credential and retries its failed write on a later read", async () => {
    const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const lease = await fixture.manager.accountAuthorizationLease();
    const listener = vi.fn();
    fixture.manager.subscribe(listener);
    const write = vi
      .spyOn(fixture.store, "setAccount")
      .mockRejectedValueOnce(new Error("Keychain locked"))
      .mockRejectedValueOnce(new Error("Keychain locked"));
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");
    const expected = `Bearer account-access-2-${"a".repeat(20)}`;

    await expect(fixture.manager.accountAuthorizationHeader()).resolves.toBe(expected);
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: null, status: "signed-in" },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({
      account: { refreshToken: `account-refresh-1-${"r".repeat(20)}` },
    });
    const refreshed = await fixture.manager.accountAuthorizationLease();
    expect(refreshed?.authorization).toBe(expected);
    expect(refreshed?.signal).toBe(lease?.signal);
    expect(lease?.signal.aborted).toBe(false);
    await expect(fixture.manager.accountAuthorizationHeader()).resolves.toBe(expected);
    await expect(fixture.store.load()).resolves.toMatchObject({
      account: { refreshToken: `account-refresh-2-${"r".repeat(20)}` },
    });
    expect(write).toHaveBeenCalledTimes(3);
    expect(fixture.refreshes).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(fixture.revocations).toEqual([]);
  });

  it("keeps a rotated Host credential across other writes and retries persistence on a later read", async () => {
    const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    const loginId = (await fixture.store.load()).hosts[0]?.viewLoginId;
    expect(loginId).toEqual(expect.any(String));
    const listener = vi.fn();
    fixture.manager.subscribeHostCredentials(listener);
    const write = vi
      .spyOn(fixture.store, "setHost")
      .mockRejectedValueOnce(new Error("Keychain locked"))
      .mockRejectedValueOnce(new Error("Keychain locked"));
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");
    const expected = `Bearer host-access-2-${"a".repeat(20)}`;

    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(expected);
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      detail: null,
      status: "signed-in",
    });
    await expect(fixture.store.load()).resolves.toMatchObject({
      hosts: [{ refreshToken: `host-refresh-1-${"r".repeat(20)}` }],
    });
    await fixture.signInAccount();
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(expected);
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(expected);
    await expect(fixture.store.load()).resolves.toMatchObject({
      hosts: [{ refreshToken: `host-refresh-2-${"r".repeat(20)}` }],
    });
    expect((await fixture.store.load()).hosts[0]?.viewLoginId).toBe(loginId);
    expect(write).toHaveBeenCalledTimes(3);
    expect(fixture.refreshes).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ status: "signed-in" });
    expect(fixture.revocations).toEqual([]);
  });

  it.each(["account", "host"] as const)(
    "does not restore %s after sign-out races a failed refresh write",
    async (kind) => {
      const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
      await fixture.manager.initialize();
      if (kind === "account") await fixture.signInAccount();
      else {
        await fixture.manager.beginHostSignIn(fixture.connection);
        const authorize = new URL(fixture.opened[0]!);
        await fixture.manager.handleCallback(
          callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
        );
      }
      const write = deferred<never>();
      const set = vi
        .spyOn(fixture.store, kind === "account" ? "setAccount" : "setHost")
        .mockImplementationOnce(() => write.promise);
      fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");
      const header =
        kind === "account"
          ? fixture.manager.accountAuthorizationHeader()
          : fixture.manager.authorizationHeader(fixture.connection);
      await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
      const signOut =
        kind === "account"
          ? fixture.manager.signOutAccount()
          : fixture.manager.signOutHost(fixture.connection);
      write.reject(new Error("Keychain locked"));
      await signOut;

      await expect(header).resolves.toBeNull();
      await expect(fixture.store.load()).resolves.toMatchObject({ account: null, hosts: [] });
      await expect(
        kind === "account"
          ? fixture.manager.accountAuthorizationHeader()
          : fixture.manager.authorizationHeader(fixture.connection),
      ).resolves.toBeNull();
      expect(set).toHaveBeenCalledOnce();
    },
  );

  it("does not restore Account credentials when sign-out races a code exchange", async () => {
    const exchange = deferred<void>();
    const fixture = await managerFixture({ exchangeGate: exchange.promise });
    await fixture.manager.initialize();
    await fixture.manager.beginAccountSignIn();
    const authorize = new URL(fixture.opened[0]!);
    const callback = fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
    );
    await vi.waitFor(() => expect(fixture.exchanges).toHaveLength(1));

    await fixture.manager.signOutAccount();
    exchange.resolve();
    await expect(callback).resolves.toBe(true);

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { status: "signed-out" },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
    expect(fixture.revocations.at(-1)?.form.get("token")).toMatch(/^account-refresh-/u);
  });

  it("does not restore an Account credential after the control plane rejects it", async () => {
    const refresh = deferred<void>();
    const fixture = await managerFixture({
      refreshGate: refresh.promise,
      tokenLifetimeSeconds: 61,
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const header = fixture.manager.accountAuthorizationHeader();
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1));
    await fixture.manager.notifyAccountCredentialRejected();
    refresh.resolve();

    await expect(header).resolves.toBeNull();
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { status: "error" },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
    expect(fixture.revocations.at(-1)?.form.get("token")).toMatch(/^account-refresh-/u);
  });

  it("does not restore Host credentials when sign-out races a refresh", async () => {
    const refresh = deferred<void>();
    const fixture = await managerFixture({
      refreshGate: refresh.promise,
      tokenLifetimeSeconds: 61,
    });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const header = fixture.manager.authorizationHeader(fixture.connection);
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1));
    await fixture.manager.signOutHost(fixture.connection);
    refresh.resolve();

    await expect(header).resolves.toBeNull();
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-out",
    });
    await expect(fixture.store.load()).resolves.toMatchObject({ hosts: [] });
    expect(fixture.revocations).toHaveLength(2);
  });

  it("keeps the network deadline active while a token response body stalls", async () => {
    let bodyCancelled = false;
    const fixture = await managerFixture({
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const signal = init?.signal;
              signal?.addEventListener(
                "abort",
                () => {
                  bodyCancelled = true;
                  controller.error(signal.reason);
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      networkTimeoutMs: 10,
    });
    await fixture.manager.initialize();
    await fixture.manager.beginAccountSignIn();
    const authorize = new URL(fixture.opened[0]!);

    await expect(
      fixture.manager.handleCallback(
        callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
      ),
    ).resolves.toBe(true);
    expect(bodyCancelled).toBe(true);
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: expect.stringMatching(/timed out/u), status: "error" },
    });
  });

  it("revokes a newly issued credential when protected storage rejects it", async () => {
    const fixture = await managerFixture({
      writeFailure: "The Desktop authorization state could not be protected.",
    });
    await fixture.manager.initialize();
    await fixture.manager.beginAccountSignIn();
    const authorize = new URL(fixture.opened[0]!);

    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
    );

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: expect.stringMatching(/could not be protected/u), status: "error" },
    });
    expect(fixture.revocations).toHaveLength(1);
    expect(fixture.revocations[0]?.form.get("token")).toMatch(/^account-refresh-/u);
    await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
  });

  it("publishes a timed-out Host authorization without waiting for another state read", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await managerFixture();
      await fixture.manager.initialize();
      const states: string[] = [];
      fixture.manager.subscribeHostCredentials(({ detail, status }) => {
        states.push(`${status}:${detail ?? ""}`);
      });

      await fixture.manager.beginHostSignIn(fixture.connection);
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(states).toEqual([
        "authorizing:Complete authorization in your browser.",
        "error:Authorization timed out. Sign in again.",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes rather than stores a Host credential abandoned during exchange", async () => {
    const exchange = deferred<void>();
    const fixture = await managerFixture({ exchangeGate: exchange.promise });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    const callback = fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    await vi.waitFor(() => expect(fixture.exchanges).toHaveLength(1));

    fixture.manager.abandonHostSignIn(fixture.connection.authority.document.deploymentId);
    exchange.resolve();
    await expect(callback).resolves.toBe(true);

    expect(fixture.manager.hostCredentialState(fixture.connection).status).toBe("signed-out");
    await expect(fixture.store.load()).resolves.toMatchObject({ hosts: [] });
    expect(fixture.revocations.at(-1)?.form.get("token")).toMatch(/^host-refresh-/u);
  });

  it("clears and revokes a Host credential abandoned during its protected write", async () => {
    const write = deferred<void>();
    const fixture = await managerFixture({ setHostGate: write.promise });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    const callback = fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    await vi.waitFor(() => expect(fixture.hostWrites).toHaveLength(1));

    fixture.manager.abandonHostSignIn(fixture.connection.authority.document.deploymentId);
    write.resolve();
    await expect(callback).resolves.toBe(true);

    await expect(fixture.store.load()).resolves.toMatchObject({ hosts: [] });
    expect(fixture.manager.hostCredentialState(fixture.connection).status).toBe("signed-out");
    expect(fixture.revocations.at(-1)?.form.get("token")).toMatch(/^host-refresh-/u);
  });

  it("opens no browser after sign-in is abandoned during the storage check", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    const deploymentId = fixture.connection.authority.document.deploymentId;

    const signIn = fixture.manager.beginHostSignIn(fixture.connection);
    fixture.manager.abandonHostSignIn(deploymentId);

    await expect(signIn).resolves.toMatchObject({ status: "signed-out" });
    expect(fixture.opened).toEqual([]);
  });

  it("fails closed when the platform credential store is unusable", async () => {
    const fixture = await managerFixture({
      storage: { available: false, detail: "This computer refuses a basic-text credential store." },
    });
    await fixture.manager.initialize();
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: expect.stringMatching(/basic-text/u), status: "error" },
    });
    await expect(fixture.manager.beginHostSignIn(fixture.connection)).rejects.toThrow(
      /basic-text/u,
    );
    expect(fixture.opened).toEqual([]);
  });

  it("rechecks protected storage before OAuth and recovers without restarting", async () => {
    const storage = { available: false, detail: "The macOS Keychain is unavailable." };
    const fixture = await managerFixture({ storage });
    await fixture.manager.initialize();
    await fixture.manager.reconcileCatalog();

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: expect.stringMatching(/macOS Keychain/u), status: "error" },
    });
    await expect(fixture.manager.beginAccountSignIn()).rejects.toThrow(/macOS Keychain/u);
    expect(fixture.opened).toEqual([]);
    expect(fixture.exchanges).toEqual([]);

    storage.available = true;
    await expect(fixture.manager.beginAccountSignIn()).resolves.toMatchObject({
      account: { status: "authorizing" },
    });
    expect(fixture.opened).toHaveLength(1);
  });
});

describe("NativeOAuthManager credential boundaries", () => {
  it("invalidates Account-derived capabilities before sign-out cleanup", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const lease = await fixture.manager.accountAuthorizationLease();

    await fixture.manager.signOutAccount();

    expect(lease?.signal.aborted).toBe(true);
    await expect(fixture.manager.accountAuthorizationLease()).resolves.toBeNull();
  });

  it("removes durable Account projections on explicit sign-out even without a live credential", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();

    await fixture.manager.signOutAccount();

    expect(fixture.accountSessions.removeAllAccountIdentities).toHaveBeenCalledOnce();
  });

  it("deletes the previous subject's projection when another Account signs in", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const lease = await fixture.manager.accountAuthorizationLease();
    const nextSubject = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);

    await fixture.manager.beginAccountSignIn();
    expect(lease?.signal.aborted).toBe(false);
    fixture.accountSubject.current = nextSubject;
    const authorize = new URL(fixture.opened.at(-1)!);
    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "another-account-code"),
    );

    expect(fixture.accountSessions.removeOtherAccountIdentities).toHaveBeenLastCalledWith({
      issuer: "https://accounts.opensteer.test",
      kind: "account",
      subject: nextSubject,
    });
    // The previous identity's capability ends exactly when the new one commits.
    expect(lease?.signal.aborted).toBe(true);
    await expect(fixture.manager.accountAuthorizationLease()).resolves.toMatchObject({
      subject: nextSubject,
    });
  });

  it("refuses a verification that returns a different Account", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const original = fixture.accountSubject.current;
    const lease = await fixture.manager.accountAuthorizationLease();

    await fixture.manager.beginAccountReauthorization();
    fixture.accountSubject.current = ControlPlaneAccountIdSchema.parse(
      `acct_${crypto.randomUUID()}`,
    );
    const authorize = new URL(fixture.opened.at(-1)!);
    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "another-account-code"),
    );

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: {
        detail: expect.stringMatching(/different Opensteer Account/u),
        identity: { subject: original },
        status: "signed-in",
      },
    });
    expect(lease?.signal.aborted).toBe(false);
    expect(fixture.revocations.at(-1)?.form.get("token")).toMatch(/^account-refresh-2-/u);
  });

  it("refuses a verification the Account did not sign in again for", async () => {
    const fixture = await managerFixture({
      idTokenClaims: { authTime: "2026-08-11T18:00:00.000Z" },
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();

    await fixture.manager.beginAccountReauthorization();
    const authorize = new URL(fixture.opened.at(-1)!);
    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "stale-verification-code"),
    );

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: {
        detail: expect.stringMatching(/did not sign in again/u),
        status: "signed-in",
      },
    });
  });

  it("refuses an Account ID token that is already expired", async () => {
    const fixture = await managerFixture({
      idTokenClaims: { expiresAt: "2026-08-11T18:59:00.000Z" },
    });
    await fixture.manager.initialize();
    await fixture.manager.beginAccountSignIn();
    const authorize = new URL(fixture.opened[0]!);

    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
    );

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: expect.stringMatching(/ID token is expired/u), status: "error" },
    });
    expect(fixture.revocations).toHaveLength(1);
  });

  it("issues no Account capability while sign-out cleanup is still running", async () => {
    const cleanup = deferred<void>();
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const lease = await fixture.manager.accountAuthorizationLease();
    fixture.accountSessions.removeAllAccountIdentities.mockImplementationOnce(async () => {
      await cleanup.promise;
      return undefined;
    });

    const signOut = fixture.manager.signOutAccount();
    await vi.waitFor(() =>
      expect(fixture.accountSessions.removeAllAccountIdentities).toHaveBeenCalledOnce(),
    );

    expect(lease?.signal.aborted).toBe(true);
    await expect(fixture.manager.accountAuthorizationLease()).resolves.toBeNull();
    cleanup.resolve();
    await signOut;
  });

  it("stays signed out when sign-out cleanup fails", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    fixture.accountSessions.removeAllAccountIdentities.mockRejectedValueOnce(
      new Error("Connected Opensteers could not be released."),
    );

    await expect(fixture.manager.signOutAccount()).resolves.toMatchObject({
      account: {
        detail: "Connected Opensteers could not be released.",
        identity: null,
        status: "error",
      },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
    await expect(fixture.manager.accountAuthorizationLease()).resolves.toBeNull();
  });

  it("never attaches an unconfirmed revocation to the Account that signs in next", async () => {
    const revoke = deferred<void>();
    const fixture = await managerFixture({ revokeFailure: true, revokeGate: revoke.promise });
    await fixture.manager.initialize();
    await fixture.signInAccount();

    const signOut = fixture.manager.signOutAccount();
    await vi.waitFor(() => expect(fixture.revocations).toHaveLength(1));
    await fixture.signInAccount();
    revoke.resolve();
    await signOut;

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: null, status: "signed-in" },
    });
  });

  it("does not restore an Account credential when sign-out races a refresh", async () => {
    const refresh = deferred<void>();
    const fixture = await managerFixture({
      refreshGate: refresh.promise,
      tokenLifetimeSeconds: 61,
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const header = fixture.manager.accountAuthorizationHeader();
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1));
    await fixture.manager.signOutAccount();
    refresh.resolve();

    await expect(header).resolves.toBeNull();
    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: { detail: null, identity: null, status: "signed-out" },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
    expect(fixture.revocations.at(-1)?.form.get("token")).toMatch(/^account-refresh-2-/u);
  });

  it("refreshes an elevated Account credential back to its base scopes", async () => {
    const fixture = await managerFixture({ tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    await fixture.manager.beginAccountReauthorization();
    const authorize = new URL(fixture.opened.at(-1)!);
    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "verification-code"),
    );
    await expect(fixture.store.load()).resolves.toMatchObject({
      account: { grantedScopes: expect.arrayContaining(["account:delete"]) },
    });

    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");
    await expect(fixture.manager.accountAuthorizationHeader()).resolves.toMatch(/^Bearer /u);

    expect(fixture.refreshes[0]?.form.get("scope")).toBe(opensteerAccountOAuthScopes.join(" "));
    const stored = await fixture.store.load();
    expect(stored.account?.grantedScopes).not.toContain("account:delete");
  });

  it("refuses a token response that grants more than the request asked for", async () => {
    const fixture = await managerFixture({
      grantedScope: [...opensteerAccountOAuthScopes, "account:delete"].join(" "),
    });
    await fixture.manager.initialize();
    await fixture.manager.beginAccountSignIn();
    const authorize = new URL(fixture.opened[0]!);

    await fixture.manager.handleCallback(
      callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
    );

    await expect(fixture.manager.state()).resolves.toMatchObject({
      account: {
        detail: expect.stringMatching(/more than this request/u),
        status: "error",
      },
    });
    await expect(fixture.store.load()).resolves.toMatchObject({ account: null });
  });
});

async function managerFixture(
  options: {
    readonly accountOrigin?: string | null;
    readonly exchangeGate?: Promise<void>;
    readonly fetch?: typeof globalThis.fetch;
    readonly grantedScope?: string;
    readonly idTokenClaims?: { readonly authTime?: string; readonly expiresAt?: string };
    readonly networkTimeoutMs?: number;
    readonly refreshGate?: Promise<void>;
    /** One scripted answer per refresh, in order; an empty queue answers with tokens. */
    readonly refreshStatuses?: number[];
    readonly revokeFailure?: boolean;
    readonly revokeGate?: Promise<void>;
    readonly setHostGate?: Promise<void>;
    readonly storage?: { available: boolean; detail?: string };
    readonly tokenLifetimeSeconds?: number;
    readonly writeFailure?: string;
  } = {},
) {
  const connection = deploymentConnection("self-hosted");
  const catalog = {
    current: catalogFor(connection),
    load: async () => catalog.current,
    removeAccountDeployments: vi.fn(
      async (_source: AccountDeploymentConnectionSource) => catalog.current,
    ),
  };
  const accountSubject = {
    current: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
  };
  const opened: string[] = [];
  const exchanges: { readonly form: URLSearchParams; readonly url: string }[] = [];
  const refreshes: { readonly form: URLSearchParams; readonly url: string }[] = [];
  const revocations: { readonly form: URLSearchParams; readonly url: string }[] = [];
  const clock = { now: new Date("2026-08-11T19:00:00.000Z") };
  let randomSequence = 0;
  let tokenSequence = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (url.endsWith("/revoke")) {
      revocations.push({ form, url });
      await options.revokeGate;
      return new Response(null, { status: options.revokeFailure ? 500 : 200 });
    }
    if (form.get("grant_type") === "refresh_token") {
      refreshes.push({ form, url });
      // Like a real fetch, a stalled refresh still ends when its caller aborts it.
      await Promise.race([
        options.refreshGate,
        new Promise<never>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
      ]);
      const status = options.refreshStatuses?.shift();
      if (status !== undefined && status !== 200) {
        return Response.json(
          { error: status === 400 ? "invalid_grant" : status === 401 ? "invalid_client" : "busy" },
          { status },
        );
      }
    } else {
      exchanges.push({ form, url });
      await options.exchangeGate;
    }
    tokenSequence += 1;
    const service = url.includes("/v1/auth/native/") ? "host" : "account";
    return Response.json({
      access_token: `${service}-access-${tokenSequence}-${"a".repeat(20)}`,
      expires_in: options.tokenLifetimeSeconds ?? 3_600,
      ...(service === "account"
        ? { id_token: accountIdToken(accountSubject.current, options.idTokenClaims ?? {}) }
        : {}),
      refresh_token: `${service}-refresh-${tokenSequence}-${"r".repeat(20)}`,
      ...(options.grantedScope === undefined ? {} : { scope: options.grantedScope }),
      token_type: "Bearer",
    });
  };
  const memoryStore = new MemoryProtectedAuthStore({
    ...(options.storage === undefined ? {} : { availability: options.storage }),
    ...(options.writeFailure === undefined ? {} : { writeFailure: options.writeFailure }),
  });
  const hostWrites: string[] = [];
  const store: ProtectedAuthStore = {
    assertAvailable: () => memoryStore.assertAvailable(),
    clearAccount: () => memoryStore.clearAccount(),
    clearHost: (deploymentId) => memoryStore.clearHost(deploymentId),
    clearHosts: (deploymentIds) => memoryStore.clearHosts(deploymentIds),
    load: () => memoryStore.load(),
    setAccount: (credential) => memoryStore.setAccount(credential),
    setHost: async (credential) => {
      hostWrites.push(credential.deploymentId);
      await options.setHostGate;
      return memoryStore.setHost(credential);
    },
  };
  const accountSessions = {
    removeAllAccountIdentities: vi.fn(async () => undefined),
    removeOtherAccountIdentities: vi.fn(
      async (_source: AccountDeploymentConnectionSource) => undefined,
    ),
  };
  const manager = new NativeOAuthManager({
    accountOrigin:
      options.accountOrigin === undefined
        ? "https://accounts.opensteer.test"
        : options.accountOrigin,
    accountSessions,
    catalog,
    fetch: options.fetch ?? fetch,
    ...(options.networkTimeoutMs === undefined
      ? {}
      : { networkTimeoutMs: options.networkTimeoutMs }),
    now: () => clock.now,
    oauth: {
      accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
      application: "desktop" as const,
      clientId: "opensteer-desktop",
      hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? ++randomSequence : 2),
    store,
  });
  return {
    accountSubject,
    accountSessions,
    catalog,
    clock,
    connection,
    exchanges,
    hostWrites,
    manager,
    opened,
    refreshes,
    revocations,
    async signInAccount() {
      await manager.beginAccountSignIn();
      const authorize = new URL(opened.at(-1)!);
      await manager.handleCallback(
        callbackUrl("account", authorize.searchParams.get("state")!, "account-code"),
      );
    },
    store,
  };
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

const discoveryKeys = testHostAuthorityKeys();

function signDiscovery(document: HostDiscoveryDocument): HostDiscoveryEnvelope {
  return signTestDiscoveryEnvelope(document, discoveryKeys);
}

function deploymentConnection(kind: "self-hosted" | "self-hosted"): DeploymentConnection {
  const deploymentId = createId("deployment");
  return DeploymentConnectionSchema.parse({
    authority: signDiscovery({
      canonicalOrigin: "https://host.opensteer.test",
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    }),
    bootstrapMethods: ["password"],
    createdAt: "2026-08-11T18:00:00.000Z",
    endpoints: [
      {
        kind: "canonical",
        origin: "https://host.opensteer.test",
        verifiedAt: "2026-08-11T18:00:00.000Z",
      },
    ],
    kind,
    lastUsedAt: "2026-08-11T18:00:00.000Z",
    name: "Home Host",
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: "2026-08-11T18:00:00.000Z",
  });
}

function catalogFor(connection: DeploymentConnection): DeploymentCatalog {
  return {
    deployments: [connection],
    revision: 1,
    schemaVersion: 4,
    selectedDeploymentId: connection.authority.document.deploymentId,
    updatedAt: "2026-08-11T18:00:00.000Z",
  };
}

function accountIdToken(
  subject: string,
  claims: {
    readonly authTime?: string;
    readonly expiresAt?: string;
  } = {},
): string {
  const header = base64UrlJson({ alg: "EdDSA", typ: "JWT" });
  const payload = base64UrlJson({
    aud: "opensteer-desktop",
    auth_time: epochSeconds(claims.authTime ?? "2026-08-11T19:00:00.000Z"),
    email: "alex@opensteer.test",
    exp: epochSeconds(claims.expiresAt ?? "2026-08-11T20:00:00.000Z"),
    iss: "https://accounts.opensteer.test",
    sub: subject,
  });
  return `${header}.${payload}.${"s".repeat(86)}`;
}

function base64UrlJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function epochSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

function callbackUrl(kind: "account" | "host", state: string, code: string): string {
  const url = new URL(`com.opensteer.opensteer:/oauth/${kind}-callback`);
  url.searchParams.set("code", code);
  url.searchParams.set(
    "iss",
    kind === "account" ? "https://accounts.opensteer.test" : "https://host.opensteer.test",
  );
  url.searchParams.set("state", state);
  return url.toString();
}
