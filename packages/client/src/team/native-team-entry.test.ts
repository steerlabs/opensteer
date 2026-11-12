import { createId, type DeploymentId } from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { TeamMemberSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { TeamEntryRefusedError } from "../auth/native-oauth.js";
import {
  DeploymentCatalogStore,
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
  const oauth = {
    accountAuthorizationLease: async () => lease,
    exchangeTeamSession: vi.fn(async () => {
      signedIn = true;
      return { admitted: true, member };
    }),
    hostCredentialState: () => ({ status: signedIn ? "signed-in" : "signed-out" }) as never,
    signOutHost: vi.fn(async () => ({}) as never),
  };
  const ids = async () =>
    (await catalog.load()).deployments.map(({ authority }) => authority.document.deploymentId);
  return {
    catalog,
    oauth,
    ids,
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
});
