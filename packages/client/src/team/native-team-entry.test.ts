import { createId, type DeploymentId } from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { TeamMemberSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { TeamEntryRefusedError, type HostOAuthState } from "../auth/native-oauth.js";
import {
  DeploymentCatalogStore,
  type DeploymentConnection,
  type VerifiedHostEndpoint,
} from "../connections/deployment-catalog.js";
import {
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  testHostAuthorityKeys,
} from "../test-support/index.js";
import { NativeTeamEntry } from "./native-team-entry.js";

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
  return {
    bootstrapMethods: ["oidc"],
    capabilities: ["native-oauth", "team-session-exchange-v1"],
    discovery,
    discoveryEnvelope: signTestDiscoveryEnvelope(discovery, keys),
    endpoint: { kind: "canonical", origin, verifiedAt: new Date().toISOString() },
  };
}

function setup() {
  const catalog = new DeploymentCatalogStore({
    filePath: "/private/catalog.json",
    privateFiles: new MemoryPrivateFilesystem(),
  });
  let signedIn = false;
  const listeners = new Set<(state: HostOAuthState) => void>();
  const state = (connection: DeploymentConnection, status: HostOAuthState["status"]) =>
    ({ connection, detail: null, key: "", status }) as HostOAuthState;
  const oauth = {
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
  return {
    catalog,
    oauth,
    ids,
    callback,
    listeners,
    signOut: () => (signedIn = false),
    entry: new NativeTeamEntry({ oauth, catalog }),
  };
}

describe("NativeTeamEntry", () => {
  it("keeps an entered team as a pending Account entry, and nothing of one that refused", async () => {
    const { catalog, entry, ids, oauth } = setup();
    const joined = team();
    await expect(entry.enter(joined, null)).resolves.toMatchObject({ admitted: true });
    const [kept] = (await catalog.load()).deployments;
    expect(kept).toMatchObject({
      accountAccess: null,
      kind: "team",
      source: { kind: "account", issuer: lease.issuer, subject: lease.subject },
    });

    const refusing = team();
    oauth.exchangeTeamSession.mockRejectedValueOnce(
      new TeamEntryRefusedError("invite-expired", "This invite has expired"),
    );
    await expect(entry.enter(refusing, null)).rejects.toMatchObject({ reason: "invite-expired" });
    expect(await ids()).toEqual([joined.discovery.deploymentId]);
  });

  it("restores only a team the directory doesn't list yet, entering again without a credential", async () => {
    const { catalog, entry, ids, oauth, signOut } = setup();
    const joined = team();
    const id: DeploymentId = joined.discovery.deploymentId;
    const verify = vi.fn(async () => joined);
    // A restart dropped the pending entry and its credential.
    await entry.enter(joined, null);
    await catalog.remove(id);
    signOut();
    oauth.exchangeTeamSession.mockClear();
    await entry.restore(id, verify);
    expect(await ids()).toEqual([id]);
    expect(oauth.exchangeTeamSession).toHaveBeenCalledTimes(1);

    // Once Account's directory lists it, a launch asks nothing of the network.
    const {
      createdAt: _c,
      lastUsedAt: _l,
      updatedAt: _u,
      ...held
    } = (await catalog.load()).deployments[0]!;
    await catalog.upsert({ ...held, accountAccess: "member" });
    verify.mockClear();
    await entry.restore(id, verify);
    expect(verify).not.toHaveBeenCalled();
  });

  it("signs in to an older team in the browser, settling only when the callback lands", async () => {
    const { callback, catalog, entry, ids, listeners, oauth, signOut } = setup();
    const older = team();
    const settled = vi.fn();
    const signingIn = entry.signIn(older).then(settled, settled);
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledOnce());
    const [kept] = (await catalog.load()).deployments;
    // Added as if by hand: the team's own sign-in, not an Account entry waiting on the directory.
    expect(kept).toMatchObject({ kind: "team", source: { kind: "manual" } });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    callback(kept!, "signed-in");
    await signingIn;
    expect(settled).toHaveBeenCalledWith(undefined);
    expect(listeners.size).toBe(0);

    // Stopped or expired in the browser: an error, and nothing kept of a team never entered.
    signOut();
    const stopped = team();
    const failing = entry.signIn(stopped);
    await vi.waitFor(() => expect(oauth.beginHostSignIn).toHaveBeenCalledTimes(2));
    const held = (await catalog.load()).deployments.find(
      ({ authority }) => authority.document.deploymentId === stopped.discovery.deploymentId,
    )!;
    callback(held, "signed-out");
    await expect(failing).rejects.toThrow(/sign-in/iu);
    expect(await ids()).toEqual([older.discovery.deploymentId]);
  });
});
