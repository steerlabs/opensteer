import { MockTeamHost, TeamSessionClient, createMemoryTeamPersistence } from "../team/index.js";
import { HostTransport, type HostNetworkSocketEvents } from "../connections/host-transport.js";
import { TeamMemberSchema } from "@opensteer/protocol";
import * as teamEntryModule from "../team/native-team-entry.js";
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
  DeploymentCatalogSchema,
  type AccountDeploymentConnectionSource,
  type DeploymentCatalog,
  type DeploymentConnection,
} from "../connections/deployment-catalog.js";
import {
  MemoryProtectedAuthStore,
  signTestDiscoveryEnvelope,
  testHostAuthorityKeys,
} from "../test-support/index.js";
import { NativeOAuthManager, TeamIdentityGrantUnsupportedError } from "./native-oauth.js";
import type { ProtectedAuthStore } from "./protected-auth-store.js";

describe("NativeOAuthManager", () => {
  it("keeps a sign-in that finished while an older sign-out was still cleaning up", async () => {
    let hold: Promise<void> | undefined;
    const f = await managerFixture({ beforeHostChange: async () => hold });
    await f.manager.initialize();
    const cleanup = Promise.withResolvers<void>();
    hold = cleanup.promise;
    const signingOut = f.manager.signOutHost(f.connection);
    hold = undefined;
    const signingIn = f.manager.signInTeam(f.connection);
    await vi.waitFor(() => expect(f.opened).toHaveLength(1), { timeout: 1000 });
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened[0]!).searchParams.get("state")!, "code"),
    );
    await expect(signingIn).resolves.toMatchObject({ status: "signed-in" });
    cleanup.resolve();
    await signingOut;
    expect(f.manager.hostCredentialState(f.connection).status).toBe("signed-in");
    expect(f.manager.isTeamSignInSuppressed(f.connection)).toBe(false);
    f.manager.dispose();
  });

  it("lets identical sign-ins queued behind background entry share one browser flow", async () => {
    const f = await managerFixture();
    await f.manager.initialize();
    const background = f.manager.signInTeam(f.connection, undefined, false).catch(() => null);
    const first = f.manager.signInTeam(f.connection);
    const second = f.manager.signInTeam(f.connection);
    await background;
    await vi.waitFor(() => expect(f.opened).toHaveLength(1), { timeout: 1000 });
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened[0]!).searchParams.get("state")!, "code"),
    );
    await expect(first).resolves.toMatchObject({ status: "signed-in" });
    await expect(second).resolves.toMatchObject({ status: "signed-in" });
    expect(f.opened).toHaveLength(1);
    f.manager.dispose();
  });

  it("keeps the browser callback valid when passive recovery joins sign-in", async () => {
    const f = await managerFixture();
    await f.manager.initialize();
    const signingIn = f.manager.signInTeam(f.connection);
    await vi.waitFor(() => expect(f.opened).toHaveLength(1), { timeout: 1000 });
    const concurrentSignIn = f.manager.signInTeam(f.connection);
    const recovering = f.manager.recoverHostAuthorization(f.connection);
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened[0]!).searchParams.get("state")!, "code"),
    );
    await expect(signingIn).resolves.toMatchObject({ status: "signed-in" });
    await expect(recovering).resolves.toBe(true);
    await expect(concurrentSignIn).resolves.toMatchObject({ status: "signed-in" });
    expect(f.opened).toHaveLength(1);
    expect(f.revocations).toEqual([]);
    f.manager.dispose();
  });

  it("keeps rotation when passive startup joins refresh and recovery skips discovery", async () => {
    const gate = deferred<void>();
    const requests: string[] = [];
    const f = await managerFixture({
      refreshGate: gate.promise,
      tokenLifetimeSeconds: 61,
      route: (url) => {
        requests.push(url);
        return undefined;
      },
    });
    await f.manager.initialize();
    await f.manager.beginHostSignIn(f.connection);
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened[0]!).searchParams.get("state")!, "code"),
    );
    f.clock.now = new Date("2026-08-11T19:00:02.000Z");
    const refreshing = f.manager.authorizationHeader(f.connection);
    await vi.waitFor(() => expect(f.refreshes).toHaveLength(1), { timeout: 1000 });
    const startup = f.manager.signInTeam(f.connection, undefined, false);
    gate.resolve();
    await expect(refreshing).resolves.toMatch(/^Bearer host-access-2/u);
    await expect(startup).resolves.toMatchObject({ status: "signed-in" });
    expect(f.revocations).toEqual([]);
    requests.length = 0;
    vi.mocked(teamEntryModule.verifyTeamEndpoint).mockClear();
    await expect(f.manager.recoverHostAuthorization(f.connection)).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(teamEntryModule.verifyTeamEndpoint).not.toHaveBeenCalled();
    expect(requests[0]).toMatch(/token$/u);
    f.manager.dispose();
  });

  it("forces exactly one refresh after rejection without discovery, and reuses a concurrent rotation", async () => {
    const requests: string[] = [];
    const f = await managerFixture({
      route: (url) => {
        requests.push(url);
        return undefined;
      },
    });
    await f.manager.initialize();
    await f.manager.beginHostSignIn(f.connection);
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened[0]!).searchParams.get("state")!, "code"),
    );
    const rejected = await f.manager.authorizationHeader(f.connection);
    requests.length = 0;
    vi.mocked(teamEntryModule.verifyTeamEndpoint).mockClear();
    await expect(f.manager.recoverHostAuthorization(f.connection, rejected)).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(teamEntryModule.verifyTeamEndpoint).not.toHaveBeenCalled();
    expect(f.refreshes).toHaveLength(1);
    await expect(f.manager.recoverHostAuthorization(f.connection, rejected)).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(teamEntryModule.verifyTeamEndpoint).not.toHaveBeenCalled();
    f.manager.dispose();
  });

  it.each(["held", "dropped", "never", "in-flight"])(
    "invalidates every team reader with %s credentials before cleanup",
    async (starting) => {
      const f = await managerFixture();
      await f.manager.initialize();
      await f.signInAccount();
      if (starting !== "never") {
        await f.manager.beginHostSignIn(f.connection);
        if (starting !== "in-flight")
          await f.manager.handleCallback(
            callbackUrl("host", new URL(f.opened.at(-1)!).searchParams.get("state")!, "code"),
          );
        if (starting === "dropped") await f.manager.signOutHost(f.connection);
      }
      const closed = vi.fn();
      const messages = vi.fn();
      const requested = vi.fn();
      const response = Promise.withResolvers<Response>();
      let events: HostNetworkSocketEvents | undefined;
      const transport = new HostTransport({
        deploymentId: f.connection.authority.document.deploymentId,
        expectedKind: "team",
        catalog: { load: f.catalog.load, subscribe: () => () => {} },
        localRuntime: { current: async () => null },
        credentials: f.manager,
        network: {
          request: () => {
            requested();
            return response.promise;
          },
          openWebSocket: (_input, handlers) => {
            events = handlers;
            handlers.open();
            return { close: closed, send() {} };
          },
        },
      });
      await transport.openSocket({ path: "/v1/realtime" }, () => ({
        open() {},
        close() {},
        error() {},
        message: messages,
      }));
      const pending = transport.exchange(
        { path: "/pending", method: "GET", headers: {} },
        (result) => result.text(),
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: "deployment-changed" });
      await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce(), { timeout: 1000 });
      const retired = vi.fn((ids?: readonly string[]) => {
        if (!ids || ids.includes(f.connection.authority.document.deploymentId))
          transport.invalidateSession();
      });
      f.manager.subscribeAccountIdentityChanges(retired);
      vi.spyOn(f.store, "clearHosts").mockRejectedValue(new Error("storage unavailable"));
      const signingOut = f.manager.signOutAccount();
      expect(retired).toHaveBeenCalledOnce();
      expect(closed).toHaveBeenCalled();
      events!.message("late Account data");
      expect(messages).not.toHaveBeenCalled();
      response.resolve(new Response("late response"));
      await rejected;
      await signingOut;
      transport.closeAllSockets();
      f.manager.dispose();
    },
  );

  it("keeps passive establishment suppressed without opening the browser", async () => {
    const f = await managerFixture();
    await f.manager.initialize();
    await f.manager.signOutHost(f.connection);
    await f.manager.signInTeam(f.connection, undefined, false);
    expect(f.manager.isTeamSignInSuppressed(f.connection)).toBe(true);
    expect(f.opened).toEqual([]);
    f.manager.dispose();
  });

  it("never adopts the outgoing Account's browser credential when cleanup fails", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    await fixture.manager.beginHostSignIn(fixture.connection);
    await fixture.manager.handleCallback(
      callbackUrl("host", new URL(fixture.opened.at(-1)!).searchParams.get("state")!, "host-code"),
    );
    vi.spyOn(fixture.store, "clearHosts").mockRejectedValue(new Error("storage unavailable"));
    await fixture.manager.signOutAccount();
    expect(await fixture.manager.authorizationHeader(fixture.connection)).toBeNull();
    fixture.manager.dispose();
  });

  it("hydrates the saved Account without retiring its browser credential", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    await fixture.signInAccount();
    await fixture.manager.beginHostSignIn(fixture.connection);
    await fixture.manager.handleCallback(
      callbackUrl("host", new URL(fixture.opened.at(-1)!).searchParams.get("state")!, "host-code"),
    );
    const saved = await fixture.store.load();
    const manager = new NativeOAuthManager({
      accountOrigin: "https://accounts.opensteer.test",
      accountSessions: fixture.accountSessions,
      catalog: fixture.catalog,
      fetch: async () => {
        throw new Error("Unexpected network");
      },
      now: () => fixture.clock.now,
      oauth: {
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        application: "desktop",
        clientId: "opensteer-desktop",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
      openExternal: async () => {
        throw new Error("Unexpected browser");
      },
      store: fixture.store,
    });
    await manager.initialize();
    expect(await manager.authorizationHeader(fixture.connection)).toBe(
      `Bearer ${saved.hosts[0]!.accessToken}`,
    );
    expect((await fixture.store.load()).hosts).toEqual(saved.hosts);
    manager.dispose();
    fixture.manager.dispose();
  });

  it("persists Account leave obligations before changing the saved credential on sign-out", async () => {
    const gate = deferred<void>();
    const leaving = vi
      .fn(async (_next: AccountDeploymentConnectionSource | null) => {
        await gate.promise;
      })
      .mockResolvedValueOnce(undefined);
    const fixture = await managerFixture({ beforeAccountIdentityChange: leaving });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const previous = (await fixture.store.load()).account;
    const lease = await fixture.manager.accountAuthorizationLease();
    const source = {
      kind: "account" as const,
      issuer: previous!.issuerOrigin,
      subject: previous!.subject,
    };
    expect(() => fixture.manager.assertAccountSource(source)).not.toThrow();
    const signOut = fixture.manager.signOutAccount();
    await vi.waitFor(() => expect(leaving).toHaveBeenCalledWith(null), { timeout: 1000 });
    expect(lease?.signal.aborted).toBe(true);
    expect(() => fixture.manager.assertAccountSource(source)).toThrow("Sign in");
    await expect(fixture.manager.accountAuthorizationLease()).resolves.toBeNull();
    expect((await fixture.store.load()).account).toEqual(previous);
    expect(fixture.accountSessions.removeAllAccountIdentities).not.toHaveBeenCalled();
    gate.resolve();
    await signOut;
    expect((await fixture.store.load()).account).toBeNull();
    fixture.manager.dispose();
  });

  it("leaves the outgoing Account before committing a replacement but preserves membership on refresh", async () => {
    const gate = deferred<void>();
    const leaving = vi
      .fn(async (_next: AccountDeploymentConnectionSource | null) => {
        await gate.promise;
      })
      .mockResolvedValueOnce(undefined);
    const fixture = await managerFixture({ beforeAccountIdentityChange: leaving });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    await fixture.signInAccount();
    expect(leaving).toHaveBeenCalledOnce();
    const previous = (await fixture.store.load()).account;
    const subject = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    await fixture.manager.beginAccountSignIn();
    fixture.accountSubject.current = subject;
    const callback = fixture.manager.handleCallback(
      callbackUrl(
        "account",
        new URL(fixture.opened.at(-1)!).searchParams.get("state")!,
        "replacement",
      ),
    );
    await vi.waitFor(
      () =>
        expect(leaving).toHaveBeenCalledWith({
          issuer: "https://accounts.opensteer.test",
          subject,
          kind: "account",
        }),
      { timeout: 1000 },
    );
    expect((await fixture.store.load()).account).toEqual(previous);
    gate.resolve();
    await callback;
    expect((await fixture.store.load()).account?.subject).toBe(subject);
    fixture.manager.dispose();
  });

  it("does not let a late leave completion clear the Account that signed in next", async () => {
    const gate = deferred<void>();
    const leaving = vi.fn<(next: AccountDeploymentConnectionSource | null) => Promise<void>>(
      async () => undefined,
    );
    const fixture = await managerFixture({ beforeAccountIdentityChange: leaving });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    leaving.mockImplementationOnce(async () => gate.promise);
    const signOut = fixture.manager.signOutAccount();
    await vi.waitFor(() => expect(leaving).toHaveBeenCalledWith(null), { timeout: 1000 });
    const nextSubject = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    fixture.accountSubject.current = nextSubject;
    await fixture.signInAccount();
    gate.resolve();
    await signOut;
    expect((await fixture.store.load()).account?.subject).toBe(nextSubject);
    expect((await fixture.manager.accountAuthorizationLease())?.subject).toBe(nextSubject);
    fixture.manager.dispose();
  });

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
      now: () => fixture.clock.now,
      fetch: async () =>
        Response.json({
          access_token: "refreshed-access-token-0123456789",
          refresh_token: "refreshed-refresh-token-0123456789",
          expires_in: 3600,
          token_type: "Bearer",
        }),
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
    fixture.clock.now = new Date("2026-08-11T20:00:02.000Z");
    vi.spyOn(fixture.store, "setHost").mockRejectedValueOnce(new Error("Keychain locked"));
    await owner.authorizationHeader(fixture.connection);
    // Bootstrap can succeed with the rotated token while its first write is pending.
    await owner.initializeViewLoginIds(fixture.connection, () => true);
    expect(owner.hostViewLoginId(fixture.connection)).toEqual(expect.any(String));
    const loginId = owner.hostViewLoginId(fixture.connection);
    await owner.authorizationHeader(fixture.connection);
    expect((await fixture.store.load()).hosts[0]?.viewLoginId).toBe(loginId);
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

  it("proves an invite in the browser before the team's own sign-in, so its callback admits", async () => {
    const older = await managerFixture();
    await older.manager.initialize();
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    // An older invite page drops `authorize` and would leave this sign-in waiting forever.
    await expect(older.manager.beginHostSignIn(older.connection, invite)).rejects.toThrow(
      /browser/iu,
    );
    expect(older.opened).toEqual([]);
    older.manager.dispose();

    const fixture = await managerFixture({
      capabilities: ["native-oauth", "team-invite-native-continuation-v1"],
    });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection, invite);
    const opened = new URL(fixture.opened[0]!);
    // The team's invite page, verifier only in the fragment, carrying the native sign-in.
    expect(opened.origin + opened.pathname).toBe(
      `https://host.opensteer.test/invite/${invite.selector}`,
    );
    expect(opened.hash).toBe(`#${invite.verifier}`);
    expect([...opened.searchParams.keys()]).toEqual(["authorize"]);
    const authorize = new URL(
      `/v1/auth/native/oauth2/authorize?${opened.searchParams.get("authorize")}`,
      opened.origin,
    );
    expect(authorize.toString()).not.toContain(invite.verifier);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    fixture.manager.dispose();
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

  // Only an OAuth verdict on the grant ends a credential. A Host that answers
  // with anything else (a misconfigured parser, our own error envelope, a
  // proxy page) has a problem of its own, and says so instead of "unreachable".
  it.each([
    ["cannot be reached", "network", /couldn’t be reached/u],
    ["answers with a server error", { status: 502, body: { error: "busy" } }, /couldn’t renew/u],
    [
      "refuses the request's content type",
      { status: 415, body: { error: { code: "bad_request", message: "Unsupported" } } },
      /couldn’t renew/u,
    ],
    [
      "answers 400 without an OAuth verdict",
      { status: 400, body: { error: { code: "bad_request", message: "Invalid" } } },
      /couldn’t renew/u,
    ],
    [
      "answers 400 with another OAuth error",
      { status: 400, body: { error: "invalid_request" } },
      /couldn’t renew/u,
    ],
  ] as const)("keeps a Host credential when the Host %s", async (_case, failure, detail) => {
    const refresh = deferred<void>();
    const options: { refreshGate?: Promise<void> } & NonNullable<
      Parameters<typeof managerFixture>[0]
    > = {
      refreshGate: refresh.promise,
      refreshStatuses: failure === "network" ? [] : [failure],
      tokenLifetimeSeconds: 61,
    };
    const fixture = await managerFixture(options);
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    const header = fixture.manager.authorizationHeader(fixture.connection);
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1));
    if (failure === "network") refresh.reject(new TypeError("fetch failed"));
    else refresh.resolve();
    await expect(header).rejects.toMatchObject({
      classification: "transient",
      message: expect.stringMatching(detail),
    });
    delete options.refreshGate;
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toMatch(
      /^Bearer host-access-/u,
    );
  });

  it("drops a definitively refused credential without suppressing sign-in", async () => {
    const fixture = await managerFixture({ refreshStatuses: [400], tokenLifetimeSeconds: 61 });
    await fixture.manager.initialize();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened[0]!);
    await fixture.manager.handleCallback(
      callbackUrl("host", authorize.searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T19:00:02.000Z");

    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBeNull();
    expect((await fixture.store.load()).hosts).toHaveLength(0);
    expect(fixture.manager.hostCredentialState(fixture.connection).status).toBe("signed-out");
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
    expect((await fixture.store.load()).signedOutTeams).toContain(
      fixture.connection.authority.document.deploymentId,
    );
    await expect(fixture.manager.recoverHostAuthorization(fixture.connection)).resolves.toBe(false);
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
    const owner = fixture.manager.teamRuntime();
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
    expect(fixture.manager.teamRuntime()).toBe(owner);
    expect(owner.signal.aborted).toBe(false);
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
    await fixture.signInAccount();
    await fixture.manager.beginHostSignIn(fixture.connection);
    const authorize = new URL(fixture.opened.at(-1)!);
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
    const expected = `Bearer host-access-3-${"a".repeat(20)}`;

    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(expected);
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      detail: null,
      status: "signed-in",
    });
    await expect(fixture.store.load()).resolves.toMatchObject({
      hosts: [{ refreshToken: `host-refresh-2-${"r".repeat(20)}` }],
    });
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(expected);
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(expected);
    await expect(fixture.store.load()).resolves.toMatchObject({
      hosts: [{ refreshToken: `host-refresh-3-${"r".repeat(20)}` }],
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

    await expect(signIn).rejects.toMatchObject({ classification: "transient" });
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

describe("NativeOAuthManager team session exchange", () => {
  const exchangeCapability = ["team-session-exchange-v1"];
  const assertion = `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`;
  const member = {
    userId: createId("user"),
    displayName: "Ada",
    handle: "ada",
    image: null,
    role: "member",
    state: "active",
    generation: "1",
    joinedAt: "2026-08-11T19:00:00.000Z",
  };

  it.each([false, true])(
    "renews an expired assertion only once (persistent refusal: %s)",
    async (persistent) => {
      let grants = 0,
        exchanges = 0;
      const f = await managerFixture({
        capabilities: exchangeCapability,
        route: (url) => {
          if (url.includes("/team-identity-grants")) {
            grants++;
            return Response.json({ assertion, expiresAt: "2026-08-11T19:11:00.000Z" });
          }
          if (!url.endsWith("/v1/team/session/exchange")) return undefined;
          exchanges++;
          if (exchanges === 1 || persistent)
            return Response.json(
              {
                error: {
                  code: "unauthorized",
                  reason: "assertion-expired",
                  message: "Expired",
                  retryable: true,
                },
              },
              { status: 401 },
            );
          return Response.json({
            admitted: false,
            member,
            tokens: {
              access_token: "a".repeat(32),
              refresh_token: "r".repeat(32),
              expires_in: 600,
              scope: "openid profile email offline_access host:access",
              token_type: "Bearer",
            },
          });
        },
      });
      try {
        await f.manager.initialize();
        await f.signInAccount();
        const exchange = f.manager.exchangeTeamSession(f.connection);
        if (persistent)
          await expect(exchange).rejects.toMatchObject({ reason: "assertion-expired" });
        else await expect(exchange).resolves.toMatchObject({ admitted: false });
        expect(grants).toBe(2);
        expect(exchanges).toBe(2);
      } finally {
        f.manager.dispose();
      }
    },
  );

  it("retains a fresh invite when refused refresh recovers through Account exchange", async () => {
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    const exchanges: unknown[] = [];
    const f = await managerFixture({
      capabilities: exchangeCapability,
      tokenLifetimeSeconds: 600,
      refreshStatuses: [400],
      route: (url, init) => {
        if (url.includes("/team-identity-grants"))
          return Response.json({ assertion, expiresAt: "2026-08-11T19:11:00.000Z" });
        if (!url.endsWith("/v1/team/session/exchange")) return undefined;
        const body = JSON.parse(String(init?.body));
        exchanges.push(body);
        if (!body.invite)
          return Response.json(
            {
              error: {
                code: "forbidden",
                reason: "not-a-member",
                message: "Ask for an invite",
                retryable: false,
              },
            },
            { status: 403 },
          );
        return Response.json({
          admitted: true,
          member,
          tokens: {
            access_token: "a".repeat(32),
            refresh_token: "r".repeat(32),
            expires_in: 600,
            scope: "openid profile email offline_access host:access",
            token_type: "Bearer",
          },
        });
      },
    });
    try {
      await f.manager.initialize();
      await f.signInAccount();
      await f.manager.beginHostSignIn(f.connection);
      await f.manager.handleCallback(
        callbackUrl("host", new URL(f.opened.at(-1)!).searchParams.get("state")!, "code"),
      );
      f.clock.now = new Date(f.clock.now.getTime() + 600_000);
      const entry = new teamEntryModule.NativeTeamEntry({
        oauth: f.manager,
        catalog: f.catalog,
        verify: (origin) => teamEntryModule.verifyTeamEndpoint(origin, { fetch: globalThis.fetch }),
        bootstrap: async () => TeamMemberSchema.parse(member),
      });
      await expect(
        entry.enter(
          {
            discovery: f.connection.authority.document,
            discoveryEnvelope: f.connection.authority,
            capabilities: f.connection.capabilities ?? [],
            bootstrapMethods: f.connection.bootstrapMethods,
            endpoint: f.connection.endpoints[0]!,
          },
          invite,
        ),
      ).resolves.toMatchObject({ admitted: true });
      expect(exchanges).toEqual([{ assertion, invite }]);
    } finally {
      f.manager.dispose();
    }
  });

  it("drops unbound browser credentials and fences browser flows on Account identity changes", async () => {
    const f = await managerFixture();
    await f.manager.initialize();
    await f.manager.beginHostSignIn(f.connection);
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened.at(-1)!).searchParams.get("state")!, "code"),
    );
    await f.signInAccount();
    expect(await f.manager.authorizationHeader(f.connection)).toBeNull();
    expect((await f.store.load()).hosts).toEqual([]);
    await f.manager.beginHostSignIn(f.connection);
    const state = new URL(f.opened.at(-1)!).searchParams.get("state")!;
    await f.manager.signOutAccount();
    await f.manager.handleCallback(callbackUrl("host", state, "late"));
    expect((await f.store.load()).hosts).toEqual([]);
  });

  it("preserves bound team credentials when the same Account reauthorizes", async () => {
    const f = await managerFixture({
      capabilities: exchangeCapability,
      route: (url) =>
        url.includes("/team-identity-grants")
          ? Response.json({ assertion, expiresAt: "2026-08-11T19:01:00.000Z" })
          : url.endsWith("/v1/team/session/exchange")
            ? Response.json({
                admitted: false,
                member,
                tokens: {
                  access_token: "a".repeat(32),
                  refresh_token: "r".repeat(32),
                  expires_in: 600,
                  scope: "openid profile email offline_access host:access",
                  token_type: "Bearer",
                },
              })
            : undefined,
    });
    await f.manager.initialize();
    await f.signInAccount();
    await f.manager.exchangeTeamSession(f.connection);
    const owner = f.manager.teamRuntime();
    const host = new MockTeamHost();
    const persistence = createMemoryTeamPersistence();
    const scope = { teamDeploymentId: host.teamId, userId: host.userId };
    const session = new TeamSessionClient({
      scope,
      owner,
      persistence,
      rpc: host.rpc,
      connect: host.connect,
    });
    const channel = { kind: "channel" as const, channelId: [...host.channels.values()][0]!.id };
    await session.setDraft(channel, "Before reauthorization");
    const lease = await f.manager.accountAuthorizationLease();
    await f.signInAccount();
    expect(f.manager.teamRuntime()).toBe(owner);
    expect(owner.signal.aborted).toBe(false);
    expect(lease?.signal.aborted).toBe(true);
    await session.setDraft(channel, "After reauthorization");
    expect(Object.values((await persistence.load(scope))!.drafts)).toEqual([
      "After reauthorization",
    ]);
    host.dispose();
    session.dispose();
    expect(await f.manager.authorizationHeader(f.connection)).toBe(`Bearer ${"a".repeat(32)}`);
  });

  it("keeps recovery nonterminal when refused team refresh falls back to an unreachable Account", async () => {
    const f = await managerFixture({
      capabilities: exchangeCapability,
      refreshStatuses: [400],
      route: (url) =>
        url.includes("/team-identity-grants") ? Response.json({}, { status: 503 }) : undefined,
    });
    await f.manager.initialize();
    await f.signInAccount();
    await f.manager.beginHostSignIn(f.connection);
    await f.manager.handleCallback(
      callbackUrl("host", new URL(f.opened.at(-1)!).searchParams.get("state")!, "code"),
    );
    await expect(f.manager.recoverHostAuthorization(f.connection)).rejects.toMatchObject({
      classification: "transient",
    });
    expect(f.manager.hostCredentialState(f.connection).status).toBe("signed-out");
    expect((await f.store.load()).hosts).toHaveLength(0);
  });

  it("refreshes and replays a rejected Account token before local expiry", async () => {
    let requests = 0;
    const f = await managerFixture({
      route: (url) =>
        url.includes("/team-identity-grants")
          ? ++requests === 1
            ? Response.json({}, { status: 401 })
            : Response.json({ assertion, expiresAt: "2026-08-11T19:01:00.000Z" })
          : undefined,
    });
    await f.manager.initialize();
    await f.signInAccount();
    await expect(
      f.manager.issueTeamIdentityGrant(f.connection.authority.document.deploymentId, {
        expectedAuthority: { ...f.connection.authority.document, hostKeyFingerprint: "unused" },
        surface: "desktop",
      } as never),
    ).resolves.toMatchObject({ assertion });
    expect(f.refreshes).toHaveLength(1);
    expect(requests).toBe(2);
  });

  it("enters a team with the Account's identity and keeps its tokens like a browser sign-in's", async () => {
    const calls: { url: string; headers: Headers; body: unknown }[] = [];
    const fixture = await managerFixture({
      capabilities: exchangeCapability,
      route: (url, init) => {
        if (!url.includes("/team-identity-grants") && !url.endsWith("/v1/team/session/exchange"))
          return undefined;
        calls.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return url.includes("/team-identity-grants")
          ? Response.json({ assertion, expiresAt: "2026-08-11T19:01:00.000Z" })
          : Response.json({
              admitted: true,
              member,
              tokens: {
                access_token: `team-access-${"t".repeat(20)}`,
                expires_in: 600,
                refresh_token: `team-refresh-${"r".repeat(20)}`,
                scope: "openid profile email offline_access host:access",
                token_type: "Bearer",
              },
            });
      },
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    const document = fixture.connection.authority.document;

    await expect(
      fixture.manager.exchangeTeamSession(fixture.connection, invite),
    ).resolves.toMatchObject({ admitted: true, member: { handle: "ada" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: `https://accounts.opensteer.test/v1/account/deployments/${document.deploymentId}/team-identity-grants`,
      body: {
        surface: "desktop",
        expectedAuthority: {
          canonicalOrigin: document.canonicalOrigin,
          deploymentId: document.deploymentId,
          hostInstanceId: document.hostInstanceId,
        },
      },
    });
    expect(calls[0]!.headers.get("authorization")).toMatch(/^Bearer account-access-/u);
    expect(calls[1]).toMatchObject({
      url: "https://host.opensteer.test/v1/team/session/exchange",
      body: { assertion, invite },
    });
    expect(calls[1]!.headers.get("authorization")).toBeNull();
    expect(fixture.manager.hostCredentialState(fixture.connection)).toMatchObject({
      status: "signed-in",
    });
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBe(
      `Bearer team-access-${"t".repeat(20)}`,
    );
    expect(fixture.opened.filter((url) => url.startsWith("https://host."))).toEqual([]);
    expect((await fixture.store.load()).hosts[0]?.accountIdentity).toMatchObject({
      issuer: "https://accounts.opensteer.test",
      subject: fixture.manager.accountIdentity()!.subject,
    });
    await fixture.manager.signOutAccount();
    await expect(fixture.manager.authorizationHeader(fixture.connection)).resolves.toBeNull();
    expect((await fixture.store.load()).hosts).toEqual([]);
  });

  it("commits no credential if Account signs out while the team exchange is in flight", async () => {
    const gate = deferred<void>();
    let started = false;
    const fixture = await managerFixture({
      capabilities: exchangeCapability,
      route: (url) => {
        if (url.includes("/team-identity-grants"))
          return Response.json({ assertion, expiresAt: "2026-08-11T19:01:00.000Z" });
        if (url.endsWith("/v1/team/session/exchange")) {
          started = true;
          const body = JSON.stringify({
            admitted: false,
            member,
            tokens: {
              access_token: "a".repeat(32),
              refresh_token: "r".repeat(32),
              expires_in: 600,
              scope: "openid profile email offline_access host:access",
              token_type: "Bearer",
            },
          });
          return new Response(
            new ReadableStream({
              async start(controller) {
                await gate.promise;
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const exchanging = fixture.manager.exchangeTeamSession(fixture.connection);
    const rejected = expect(exchanging).rejects.toThrow();
    await vi.waitFor(() => expect(started, "team exchange never started").toBe(true), {
      timeout: 1000,
    });
    await fixture.manager.signOutAccount();
    gate.resolve();
    await rejected;
    expect((await fixture.store.load()).hosts).toEqual([]);
    expect(fixture.manager.hostCredentialState(fixture.connection).status).toBe("signed-out");
  });

  it("refreshes manual-row capabilities during passive entry and keeps membership refusal", async () => {
    const fixture = await managerFixture({
      capabilities: exchangeCapability,
      route: (url) =>
        url.includes("/team-identity-grants")
          ? Response.json({ assertion, expiresAt: "2026-08-11T19:01:00.000Z" })
          : url.endsWith("/v1/team/session/exchange")
            ? Response.json(
                {
                  error: {
                    code: "forbidden",
                    message: "You're not a member of this team. Ask for an invite.",
                    reason: "not-a-member",
                    retryable: false,
                  },
                },
                { status: 403 },
              )
            : undefined,
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const fresh = await teamEntryModule.verifyTeamEndpoint("https://host.opensteer.test", {
      fetch: globalThis.fetch,
    });
    const stale = { ...fixture.connection, capabilities: [] };
    fixture.catalog.current = catalogFor(stale);
    vi.mocked(teamEntryModule.verifyTeamEndpoint).mockResolvedValue(fresh);
    await expect(fixture.manager.signInTeam(stale, undefined, false)).rejects.toMatchObject({
      name: "TeamEntryRefusedError",
      reason: "not-a-member",
    });
    expect(fixture.opened.filter((url) => url.startsWith("https://host."))).toEqual([]);
    await expect(fixture.store.load()).resolves.toMatchObject({ hosts: [] });
  });

  it("tells an Account without identity grants apart from one that refuses the grant", async () => {
    let grant: Response = Response.json(
      { error: "Not Found", message: "Route POST:/v1/account/… not found", statusCode: 404 },
      { status: 404 },
    );
    const fixture = await managerFixture({
      capabilities: exchangeCapability,
      route: (url) => (url.includes("/team-identity-grants") ? grant : undefined),
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    await expect(
      fixture.manager.exchangeTeamSession(fixture.connection, invite),
    ).rejects.toBeInstanceOf(TeamIdentityGrantUnsupportedError);
    grant = Response.json(
      { error: { code: "not_found", message: "Team was not found" } },
      { status: 404 },
    );
    const refused = await fixture.manager
      .exchangeTeamSession(fixture.connection, invite)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(TeamIdentityGrantUnsupportedError);
  });

  it("does not exchange an outgoing Account's invite after a refused refresh", async () => {
    const refresh = deferred<void>();
    const fixture = await managerFixture({
      refreshGate: refresh.promise,
      refreshStatuses: [400],
      capabilities: exchangeCapability,
    });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    await fixture.manager.beginHostSignIn(fixture.connection);
    await fixture.manager.handleCallback(
      callbackUrl("host", new URL(fixture.opened.at(-1)!).searchParams.get("state")!, "host-code"),
    );
    fixture.clock.now = new Date("2026-08-11T20:00:02.000Z");
    const grant = vi.spyOn(fixture.manager, "exchangeTeamSession");
    const signingIn = fixture.manager.signInTeam(fixture.connection, {
      selector: "s".repeat(32),
      verifier: "v".repeat(43),
    });
    const rejected = expect(signingIn).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.refreshes).toHaveLength(1), { timeout: 1000 });
    fixture.clock.now = new Date("2026-08-11T19:00:00.000Z");
    fixture.accountSubject.current = ControlPlaneAccountIdSchema.parse(
      `acct_${crypto.randomUUID()}`,
    );
    await fixture.signInAccount();
    refresh.resolve();
    await rejected;
    expect(grant).not.toHaveBeenCalled();
    expect((await fixture.store.load()).hosts).toEqual([]);
  });

  it("rejects entry suspended in credential lookup after explicit team sign-out", async () => {
    const fixture = await managerFixture();
    await fixture.manager.initialize();
    const lookup = deferred<string | null>();
    vi.spyOn(fixture.manager, "authorizationHeader").mockReturnValueOnce(lookup.promise);
    const signingIn = fixture.manager.signInTeam(fixture.connection);
    const rejected = expect(signingIn).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.manager.authorizationHeader).toHaveBeenCalled(), {
      timeout: 1000,
    });
    await fixture.manager.signOutHost(fixture.connection);
    lookup.resolve(null);
    await rejected;
    expect(fixture.opened).toEqual([]);
    expect(fixture.manager.isTeamSignInSuppressed(fixture.connection)).toBe(true);
  });

  it("signs in through the browser when the team does not advertise the exchange", async () => {
    const route = vi.fn((_url: string) => undefined);
    const fixture = await managerFixture({ route });
    await fixture.manager.initialize();
    await fixture.signInAccount();
    const signingIn = fixture.manager.signInTeam(fixture.connection);
    await vi.waitFor(() => expect(fixture.opened).toHaveLength(2));
    await fixture.manager.handleCallback(
      callbackUrl("host", new URL(fixture.opened.at(-1)!).searchParams.get("state")!, "code"),
    );
    await expect(signingIn).resolves.toMatchObject({ status: "signed-in" });
    expect(new URL(fixture.opened.at(-1)!).pathname).toBe("/v1/auth/native/oauth2/authorize");
    expect(route.mock.calls.filter(([url]) => url.includes("team"))).toEqual([]);
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
    readonly beforeAccountIdentityChange?: (
      next: AccountDeploymentConnectionSource | null,
    ) => Promise<void>;
    readonly accountOrigin?: string | null;
    readonly beforeHostChange?: () => Promise<void>;
    readonly capabilities?: readonly string[];
    readonly exchangeGate?: Promise<void>;
    readonly fetch?: typeof globalThis.fetch;
    readonly grantedScope?: string;
    readonly idTokenClaims?: { readonly authTime?: string; readonly expiresAt?: string };
    readonly networkTimeoutMs?: number;
    readonly refreshGate?: Promise<void>;
    /** One scripted answer per refresh, in order; an empty queue answers with tokens. */
    readonly refreshStatuses?: (number | { readonly status: number; readonly body: unknown })[];
    readonly revokeFailure?: boolean;
    readonly revokeGate?: Promise<void>;
    /** Answers JSON calls (Account grants, team exchange) before the OAuth fake sees them. */
    readonly route?: (url: string, init: RequestInit | undefined) => Response | undefined;
    readonly setHostGate?: Promise<void>;
    readonly storage?: { available: boolean; detail?: string };
    readonly tokenLifetimeSeconds?: number;
    readonly writeFailure?: string;
  } = {},
) {
  const connection = deploymentConnection(
    "team",
    options.capabilities ?? ["team-native-browser-return-v1"],
  );
  vi.spyOn(teamEntryModule, "verifyTeamEndpoint").mockResolvedValue({
    discovery: connection.authority.document,
    discoveryEnvelope: connection.authority,
    capabilities: connection.capabilities ?? [],
    bootstrapMethods: connection.bootstrapMethods,
    endpoint: connection.endpoints[0]!,
  });
  const catalog = {
    upsert: async (
      input: import("../connections/deployment-catalog.js").DeploymentConnectionInput,
    ) => {
      catalog.current = {
        ...catalog.current,
        deployments: [DeploymentConnectionSchema.parse({ ...connection, ...input })],
      };
      return catalog.current;
    },
    addPendingAccountDeployment: async () => catalog.current,
    remove: async () => catalog.current,
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
    const routed = options.route?.(url, init);
    if (routed) return routed;
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
      const answer = options.refreshStatuses?.shift();
      if (typeof answer === "object") return Response.json(answer.body, { status: answer.status });
      if (answer !== undefined && answer !== 200) {
        return Response.json(
          { error: answer === 400 ? "invalid_grant" : answer === 401 ? "invalid_client" : "busy" },
          { status: answer },
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
    setTeamSignOutSuppression: (deploymentId, suppressed) =>
      memoryStore.setTeamSignOutSuppression(deploymentId, suppressed),
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
    ...(options.beforeAccountIdentityChange
      ? { beforeAccountIdentityChange: options.beforeAccountIdentityChange }
      : {}),
    ...(options.beforeHostChange ? { beforeHostChange: options.beforeHostChange } : {}),
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

function deploymentConnection(
  kind: "team" | "team",
  capabilities: readonly string[] = [],
): DeploymentConnection {
  const deploymentId = createId("deployment");
  return DeploymentConnectionSchema.parse({
    capabilities,
    authority: signDiscovery({
      canonicalOrigin: "https://host.opensteer.test",
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        kind: "team" as const,
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
    schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
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
