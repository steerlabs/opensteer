import { withTimeout } from "@opensteer/shared/withTimeout";
import { createId, type DeploymentId } from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { TeamMemberSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { TeamEntryRefusedError, type HostOAuthState } from "../auth/native-oauth.js";
import {
  DeploymentCatalogStore,
  deploymentConnectionFromVerifiedEndpoints,
  type DeploymentConnection,
  type VerifiedHostEndpoint,
} from "../connections/deployment-catalog.js";
import {
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  testHostAuthorityKeys,
} from "../test-support/index.js";
import { NativeTeamEntry } from "./native-team-entry.js";

let latestVerified: VerifiedHostEndpoint;
const keys = testHostAuthorityKeys();
const lease = {
  authorization: "Bearer account",
  issuer: "https://accounts.opensteer.example",
  signal: new AbortController().signal,
  subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
};
const member = TeamMemberSchema.parse({
  userId: createId("user"),
  displayName: "You",
  handle: "you",
  image: null,
  role: "member",
  state: "active",
  generation: "1",
  joinedAt: new Date().toISOString(),
});

function team(): VerifiedHostEndpoint {
  const origin = "https://acme.teams.opensteer.example";
  const discovery = {
    canonicalOrigin: origin,
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" as const },
    deploymentShape: { kind: "team" as const },
  };
  latestVerified = {
    bootstrapMethods: ["oidc"],
    capabilities: ["native-oauth", "team-session-exchange-v1"],
    discovery,
    discoveryEnvelope: signTestDiscoveryEnvelope(discovery, keys),
    endpoint: { kind: "canonical", origin, verifiedAt: new Date().toISOString() },
  };
  return latestVerified;
}

function setup() {
  const catalog = new DeploymentCatalogStore({
    filePath: "/private/catalog.json",
    privateFiles: new MemoryPrivateFilesystem(),
  });
  let signedIn = false;
  const verify = vi.fn(async () => latestVerified);
  const listeners = new Set<(state: HostOAuthState) => void>();
  const state = (connection: DeploymentConnection, status: HostOAuthState["status"]) =>
    ({ connection, detail: null, key: "", status }) as HostOAuthState;
  const oauth = {
    refreshTeamAuthorization: vi.fn(async (): Promise<string | null> => null),
    teamEntryLease: () => ({
      generation: 0,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    }),
    resumeTeamSignIn: vi.fn(async () => {}),
    isTeamSignInSuppressed: vi.fn(() => false),
    authorizationHeader: vi.fn(async (): Promise<string | null> =>
      signedIn ? "Bearer team" : null,
    ),
    accountIdentity: () => lease,
    accountAuthorizationLease: async () => lease,
    // Like desktop: the browser opens and the call returns; the callback lands later.
    beginHostSignIn: vi.fn(async (connection: DeploymentConnection) => {
      const authorizing = state(connection, "authorizing");
      for (const listener of listeners) listener(authorizing);
      return authorizing;
    }),
    exchangeTeamSession: vi.fn(async () => {
      signedIn = true;
      return { admitted: true, member };
    }),
    hostCredentialState: () => ({ status: signedIn ? "signed-in" : "signed-out" }) as never,
    signOutHost: vi.fn(async () => ({}) as never),
    subscribeHostCredentials: (listener: (state: HostOAuthState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  /** The browser sign-in of `connection` ends as `status`. */
  const callback = (connection: DeploymentConnection, status: HostOAuthState["status"]) => {
    if (status === "signed-in") signedIn = true;
    for (const listener of listeners) listener(state(connection, status));
  };
  const ids = async () =>
    (await catalog.load()).deployments.map(({ authority }) => authority.document.deploymentId);
  const bootstrap = vi.fn(async () => member);
  return {
    bootstrap,
    catalog,
    oauth,
    ids,
    callback,
    listeners,
    signOut: () => (signedIn = false),
    entry: new NativeTeamEntry({ oauth, catalog, bootstrap, verify }),
    verify,
    discover: (verified: VerifiedHostEndpoint) => {
      latestVerified = verified;
    },
  };
}

describe("NativeTeamEntry", () => {
  it("forces refresh when recovery joins startup using the rejected token", async () => {
    const { entry, oauth, verify } = setup();
    const verified = team();
    const gate = Promise.withResolvers<VerifiedHostEndpoint>();
    verify.mockReturnValueOnce(gate.promise);
    oauth.authorizationHeader.mockResolvedValue("Bearer rejected");
    oauth.refreshTeamAuthorization.mockResolvedValue("Bearer renewed");
    const input = {
      deploymentId: verified.discovery.deploymentId,
      origin: verified.discovery.canonicalOrigin,
      mode: "passive" as const,
    };
    const startup = entry.authorize(input);
    const recovery = entry.authorize({ ...input, recover: { authorization: "Bearer rejected" } });
    gate.resolve(verified);
    await startup;
    await expect(recovery).resolves.toMatchObject({ status: "authorized" });
    expect(oauth.refreshTeamAuthorization).toHaveBeenCalledOnce();
  });

  it.each(["signed-in", "signed-out"] as const)(
    "releases browser entry on %s while the platform promise is unfinished",
    async (status) => {
      const { entry, oauth, callback, catalog } = setup();
      const verified = { ...team(), capabilities: ["native-oauth"] as const };
      latestVerified = verified;
      oauth.beginHostSignIn.mockImplementationOnce(async (connection) => {
        callback(connection, "authorizing");
        return new Promise<HostOAuthState>(() => {});
      });
      const entering = entry.authorize({
        deploymentId: verified.discovery.deploymentId,
        origin: verified.discovery.canonicalOrigin,
        mode: "interactive",
      });
      await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledOnce(), {
        timeout: 1000,
      });
      callback((await catalog.load()).deployments[0]!, status);
      await expect(
        withTimeout(entering, 1000, {
          timeoutError: () => new Error("Browser entry never settled after its flow ended"),
        }),
      ).resolves.toMatchObject({
        status: status === "signed-in" ? "authorized" : "retryable",
      });
    },
  );

  it("releases unfinished browser work when the entry fence is invalidated", async () => {
    const { entry, oauth, callback } = setup();
    const controller = new AbortController();
    oauth.teamEntryLease = () => ({
      generation: 0,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const verified = { ...team(), capabilities: ["native-oauth"] as const };
    latestVerified = verified;
    oauth.beginHostSignIn.mockImplementationOnce(async (connection) => {
      callback(connection, "authorizing");
      return new Promise<HostOAuthState>(() => {});
    });
    const input = {
      deploymentId: verified.discovery.deploymentId,
      origin: verified.discovery.canonicalOrigin,
    };
    const entering = entry.authorize({ ...input, mode: "interactive" });
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledOnce(), { timeout: 1000 });
    controller.abort(new Error("signed out"));
    await expect(
      withTimeout(entering, 1000, {
        timeoutError: () => new Error("Browser entry never settled after its flow ended"),
      }),
    ).resolves.toMatchObject({ status: "superseded" });
    oauth.teamEntryLease = () => ({
      generation: 1,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    oauth.authorizationHeader.mockResolvedValue("Bearer valid");
    await expect(entry.authorize({ ...input, mode: "passive" })).resolves.toMatchObject({
      status: "authorized",
    });
  });

  it("recovers a valid credential without waiting for an unfinished interactive browser", async () => {
    const { entry, oauth, callback, catalog } = setup();
    const verified = { ...team(), capabilities: ["native-oauth"] as const };
    latestVerified = verified;
    oauth.beginHostSignIn.mockImplementationOnce(async (connection) => {
      callback(connection, "authorizing");
      return new Promise<HostOAuthState>(() => {});
    });
    const input = {
      deploymentId: verified.discovery.deploymentId,
      origin: verified.discovery.canonicalOrigin,
    };
    const entering = entry.authorize({ ...input, mode: "interactive" });
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledOnce(), { timeout: 1000 });
    oauth.refreshTeamAuthorization.mockResolvedValue("Bearer valid");
    await expect(
      withTimeout(
        entry.authorize({
          ...input,
          mode: "passive",
          recover: { authorization: "Bearer rejected" },
        }),
        1000,
        {
          timeoutError: () => new Error("Passive recovery waited for the unfinished browser"),
        },
      ),
    ).resolves.toMatchObject({ status: "authorized" });
    callback((await catalog.load()).deployments[0]!, "signed-in");
    await entering;
  });

  it.each([false, true])(
    "coalesces passive then interactive entry (authorized: %s)",
    async (authorized) => {
      const { entry, oauth, verify } = setup();
      const verified = team();
      const gate = Promise.withResolvers<VerifiedHostEndpoint>();
      verify.mockReturnValueOnce(gate.promise);
      oauth.authorizationHeader.mockResolvedValue(authorized ? "Bearer held" : null);
      oauth.accountAuthorizationLease = async () => null as never;
      oauth.beginHostSignIn.mockResolvedValue({ status: "signed-in" } as HostOAuthState);
      const input = {
        deploymentId: verified.discovery.deploymentId,
        origin: verified.discovery.canonicalOrigin,
      };
      const passive = entry.authorize({ ...input, mode: "passive" });
      const interactive = entry.authorize({ ...input, mode: "interactive" });
      expect(verify).toHaveBeenCalledOnce();
      gate.resolve(verified);
      await passive;
      await expect(interactive).resolves.toMatchObject({ status: "authorized" });
      expect(oauth.beginHostSignIn).toHaveBeenCalledTimes(authorized ? 0 : 1);
      expect(verify).toHaveBeenCalledTimes(authorized ? 1 : 2);
    },
  );

  it("does not fold an explicit invite join into an in-flight plain sign-in", async () => {
    const { entry, oauth, verify } = setup();
    const verified = team();
    const gate = Promise.withResolvers<VerifiedHostEndpoint>();
    verify.mockReturnValueOnce(gate.promise);
    oauth.authorizationHeader.mockResolvedValue("Bearer held");
    const input = {
      deploymentId: verified.discovery.deploymentId,
      origin: verified.discovery.canonicalOrigin,
      mode: "interactive" as const,
    };
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    const plain = entry.authorize(input);
    const joining = entry.authorize({ ...input, invite });
    gate.resolve(verified);
    await plain;
    await joining;
    expect(oauth.exchangeTeamSession).toHaveBeenCalledWith(
      expect.anything(),
      invite,
      expect.anything(),
    );
  });

  it("does not remove a newer entry when an obsolete exchange refuses", async () => {
    const { entry, oauth, catalog } = setup();
    const verified = team();
    const pending = Promise.withResolvers<{ admitted: boolean; member: typeof member }>();
    oauth.exchangeTeamSession.mockImplementationOnce(() => pending.promise);
    const first = entry.ensureAuthorized(verified);
    const rejected = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(oauth.exchangeTeamSession).toHaveBeenCalledOnce());
    await catalog.upsert(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [verified],
        kind: "team",
        name: "Updated",
        source: { kind: "manual" },
      }),
    );
    pending.reject(new Error("obsolete refusal"));
    await rejected;
    expect((await catalog.load()).deployments).toHaveLength(1);
  });

  it("claims entry before verification and ignores sign-out during discovery", async () => {
    const { entry, oauth, verify } = setup();
    const verified = team();
    const pending = Promise.withResolvers<VerifiedHostEndpoint>();
    verify.mockReturnValueOnce(pending.promise);
    let current = true;
    oauth.teamEntryLease = () => ({
      generation: 0,
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (!current) throw new Error("superseded");
      },
    });
    const restoring = entry.restore(
      verified.discovery.deploymentId,
      verified.discovery.canonicalOrigin,
    );
    const rejected = expect(restoring).rejects.toThrow();
    current = false;
    pending.resolve(verified);
    await rejected;
    expect(oauth.exchangeTeamSession).not.toHaveBeenCalled();
  });

  it("fences entry before the initial catalog lookup can resume", async () => {
    const { entry, oauth, catalog } = setup();
    const verified = team();
    const lookup = Promise.withResolvers<Awaited<ReturnType<typeof catalog.load>>>();
    const original = await catalog.load();
    let invalidated = false;
    oauth.teamEntryLease = () => ({
      generation: 0,
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (invalidated) throw new Error("Entry changed");
      },
    });
    vi.spyOn(catalog, "load").mockReturnValueOnce(lookup.promise);
    const entering = entry.ensureAuthorized(verified);
    const rejected = expect(entering).rejects.toThrow("Team authorization changed");
    invalidated = true;
    lookup.resolve(original);
    await rejected;
    expect(oauth.resumeTeamSignIn).not.toHaveBeenCalled();
    expect(oauth.exchangeTeamSession).not.toHaveBeenCalled();
    expect(oauth.beginHostSignIn).not.toHaveBeenCalled();
  });

  it("passes a fresh invite to browser fallback despite a locally signed-in credential", async () => {
    const { entry, oauth, callback, catalog } = setup();
    const verified = team();
    await entry.enter(verified, null);
    const older = {
      ...verified,
      capabilities: ["native-oauth", "team-invite-native-continuation-v1"] as const,
    };
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    latestVerified = older;
    const entering = entry.enter(older, invite);
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledOnce(), { timeout: 1000 });
    callback((await catalog.load()).deployments[0]!, "signed-in");
    await entering;
  });

  it("uses an explicit invite to re-admit a viewer with a stale saved credential", async () => {
    const { entry, oauth } = setup();
    const verified = team();
    await entry.enter(verified, null);
    oauth.exchangeTeamSession.mockClear();
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    await entry.enter(verified, invite);
    expect(oauth.exchangeTeamSession).toHaveBeenCalledWith(
      expect.anything(),
      invite,
      expect.anything(),
    );
  });

  it("keeps an entered team as a pending Account entry, and nothing of one that refused", async () => {
    const { catalog, entry, ids, oauth, signOut } = setup();
    const joined = team();
    await expect(entry.enter(joined, null)).resolves.toMatchObject({ admitted: true });
    const [kept] = (await catalog.load()).deployments;
    expect(kept).toMatchObject({
      accountAccess: null,
      kind: "team",
      source: { kind: "account", issuer: lease.issuer, subject: lease.subject },
    });

    signOut();
    const refusing = team();
    oauth.exchangeTeamSession.mockRejectedValueOnce(
      new TeamEntryRefusedError("invite-expired", "This invite has expired"),
    );
    await expect(entry.enter(refusing, null)).rejects.toMatchObject({ reason: "invite-expired" });
    expect(await ids()).toEqual([joined.discovery.deploymentId]);
  });

  it("restores only a team the directory doesn't list yet, entering again without a credential", async () => {
    const { catalog, entry, ids, oauth, signOut, verify } = setup();
    const joined = team();
    const id: DeploymentId = joined.discovery.deploymentId;
    verify.mockResolvedValue(joined);
    // A restart dropped the pending entry and its credential.
    await entry.enter(joined, null);
    await catalog.remove(id);
    signOut();
    oauth.exchangeTeamSession.mockClear();
    await entry.restore(id, joined.discovery.canonicalOrigin);
    expect(await ids()).toEqual([id]);
    expect(oauth.exchangeTeamSession).toHaveBeenCalledTimes(1);

    // Even directory-listed entries verify discovery on passive entry.
    const {
      createdAt: _c,
      lastUsedAt: _l,
      updatedAt: _u,
      ...held
    } = (await catalog.load()).deployments[0]!;
    await catalog.upsert({ ...held, accountAccess: "member" });
    verify.mockClear();
    await entry.restore(id, joined.discovery.canonicalOrigin);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("bootstraps cached credentials through the supplied pinned transport", async () => {
    const { entry, oauth, bootstrap } = setup();
    oauth.authorizationHeader.mockResolvedValue("Bearer rejected-before-expiry");
    await expect(entry.enter(team(), null)).resolves.toEqual({ admitted: false, member });
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("updates a saved team's verified capabilities before authorization", async () => {
    const { catalog, entry, oauth } = setup();
    const verified = team();
    const { deploymentConnectionFromVerifiedEndpoints } =
      await import("../connections/deployment-catalog.js");
    await catalog.upsert(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [{ ...verified, capabilities: ["native-oauth"] }],
        kind: "team",
        name: "Team",
        source: { kind: "manual" },
      }),
    );
    await entry.ensureAuthorized(verified, null, false);
    expect(oauth.exchangeTeamSession).toHaveBeenCalledOnce();
    expect((await catalog.load()).deployments[0]?.capabilities).toContain(
      "team-session-exchange-v1",
    );
  });

  it("reuses a refreshed credential and leaves an unavailable refresh retryable", async () => {
    const { catalog, entry, oauth } = setup();
    const verified = team();
    oauth.authorizationHeader.mockResolvedValue("Bearer refreshed");
    await entry.ensureAuthorized(verified);
    expect(oauth.beginHostSignIn).not.toHaveBeenCalled();
    oauth.authorizationHeader.mockRejectedValue(new Error("Network unavailable"));
    await expect(entry.ensureAuthorized(verified)).rejects.toThrow("Network unavailable");
    expect(oauth.beginHostSignIn).not.toHaveBeenCalled();
    expect((await catalog.load()).deployments).toHaveLength(1);
  });

  it("silently exchanges for a member, but never opens the browser on refusal or outage", async () => {
    const { entry, oauth } = setup();
    await entry.ensureAuthorized(team());
    expect(oauth.exchangeTeamSession).toHaveBeenCalledOnce();
    expect(oauth.beginHostSignIn).not.toHaveBeenCalled();
    oauth.authorizationHeader.mockResolvedValue(null);
    for (const error of [
      new TeamEntryRefusedError("not-a-member", "Ask for an invite"),
      new Error("Account unreachable"),
    ]) {
      oauth.exchangeTeamSession.mockRejectedValueOnce(error);
      await expect(entry.ensureAuthorized(team())).rejects.toBe(error);
    }
    expect(oauth.beginHostSignIn).not.toHaveBeenCalled();
  });

  it("leaves explicit sign-out suppressed during restore until explicit sign-in", async () => {
    const { entry, oauth } = setup();
    oauth.isTeamSignInSuppressed.mockReturnValue(true);
    await entry.ensureAuthorized(team(), null, false);
    expect(oauth.exchangeTeamSession).not.toHaveBeenCalled();
    expect(oauth.beginHostSignIn).not.toHaveBeenCalled();
    await entry.ensureAuthorized(team());
    expect(oauth.resumeTeamSignIn).toHaveBeenCalled();
    expect(oauth.exchangeTeamSession).toHaveBeenCalledOnce();
  });

  it("signs in to an older team in the browser, settling only when the callback lands", async () => {
    const { callback, catalog, entry, ids, listeners, oauth, signOut } = setup();
    const older = { ...team(), capabilities: ["native-oauth"] as const };
    const settled = vi.fn();
    const invite = { selector: "s".repeat(32), verifier: "v".repeat(43) };
    latestVerified = older;
    const signingIn = entry.ensureAuthorized(older, invite).then(settled, settled);
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledOnce());
    const [kept] = (await catalog.load()).deployments;
    // The invite goes to the browser sign-in, which proves it before the team's callback.
    expect(oauth.beginHostSignIn).toHaveBeenCalledWith(kept, invite, expect.anything());
    // Added as if by hand: the team's own sign-in, not an Account entry waiting on the directory.
    expect(kept).toMatchObject({ kind: "team", source: { kind: "manual" } });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    callback(kept!, "signed-in");
    await signingIn;
    expect(settled).toHaveBeenCalledWith(null);
    expect(listeners.size).toBe(0);

    // Stopped or expired in the browser: an error, and nothing kept of a team never entered.
    signOut();
    const stopped = { ...team(), capabilities: ["native-oauth"] as const };
    latestVerified = stopped;
    const failing = entry.ensureAuthorized(stopped, null);
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledTimes(2));
    const held = (await catalog.load()).deployments.find(
      ({ authority }) => authority.document.deploymentId === stopped.discovery.deploymentId,
    )!;
    callback(held, "signed-out");
    await expect(failing).rejects.toThrow(/sign-in/iu);
    expect(await ids()).toEqual([older.discovery.deploymentId]);
  });
});
