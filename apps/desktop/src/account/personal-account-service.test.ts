import { createId } from "@opensteer/core";
import {
  AccountLinkGenerationSchema,
  AccountDeploymentSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  ControlPlaneAccountIdSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  PersonalHostAccountLinkOperationIdSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  PersonalRemoteAccessStatusSchema,
  type PersonalRemoteAccessStatus,
} from "@opensteer/protocol";
import { DesktopPersonalAccountService } from "./personal-account-service.js";
import {
  DesktopPersonalAccountLinkStateSchema,
  type DesktopPersonalAccountLinkState,
  type PersonalAccountUnlinkStep,
} from "./personal-account-link-store.js";
import type { PersonalDeploymentManifest } from "../secrets/personal-deployment-store.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";

const steps = [
  "disable-connect",
  "revoke-account-sessions",
  "revoke-connect-resource",
  "remove-host-link",
  "repair-hosted-oauth-connections",
  "retain-local-data",
] as const satisfies readonly PersonalAccountUnlinkStep[];

describe("DesktopPersonalAccountService", () => {
  it.each(steps.map((_step, boundary) => boundary))(
    "resumes unlink after durable step boundary %i without deleting local data or private routes",
    async (boundary) => {
      const fixture = unlinkFixture(boundary);
      const published: string[] = [];
      fixture.service.subscribe((status) => published.push(status.unlinkStep ?? status.status));

      await expect(fixture.service.unlink()).resolves.toMatchObject({ status: "unlinked" });

      expect(fixture.events).toEqual(
        ["disable", "sessions", "resource", "host-link", "oauth"].slice(boundary),
      );
      // Every step boundary is still announced…
      expect(published).toEqual([
        ...(boundary === 0 ? ["disable-connect"] : []),
        ...steps.slice(boundary + 1),
        "unlinking",
        "unlinked",
      ]);
      // …but progress is derived from the journal that was just written, so
      // the Host is read once before the ladder and once authoritatively after
      // it, not once per rung.
      expect(fixture.host.status).toHaveBeenCalledTimes(2);
      expect(fixture.manifest.name).toBe(fixture.initialManifestName);
      expect(fixture.manifest.workspaceRoot).toBe("/local/workspaces");
      expect(fixture.privateRoute).toBe("https://studio.tailnet.test");
      expect(fixture.tokens).toEqual(["vault-token-kept"]);
      await expect(fixture.links.load()).resolves.toBeNull();
    },
  );

  it("writes a linked rename through Account and leaves the offline projection unchanged on failure", async () => {
    const fixture = unlinkFixture(0);
    fixture.account.renamePersonalDeployment.mockRejectedValueOnce(new Error("Account offline"));
    await expect(fixture.service.rename("New label")).rejects.toThrow("Account offline");
    expect(fixture.manifest.name).toBe("Local last-known label");

    fixture.account.renamePersonalDeployment.mockResolvedValueOnce({
      ...fixture.directoryDeployment,
      name: "New label",
    });
    await expect(fixture.service.rename("New label")).resolves.toMatchObject({
      displayName: "New label",
    });
    expect(fixture.manifest.name).toBe("New label");
  });

  it("derives linked status from the Host with no Desktop journal while signed out", async () => {
    const fixture = unlinkFixture(0);
    await fixture.links.clear();
    fixture.account.accountIdentity.mockResolvedValueOnce(null as never);

    await expect(fixture.service.status()).resolves.toMatchObject({
      account: fixture.accountIdentity,
      status: "linked",
    });
  });

  it("reports a Host-owned unactivated link as recoverable rather than linked", async () => {
    const fixture = unlinkFixture(0);
    await fixture.links.clear();
    const status = await fixture.host.status();
    fixture.host.status.mockResolvedValueOnce(
      PersonalRemoteAccessStatusSchema.parse({
        ...status,
        accountLink: status.accountLink ? { ...status.accountLink, state: "activating" } : null,
      }),
    );

    await expect(fixture.service.status()).resolves.toMatchObject({
      account: fixture.accountIdentity,
      status: "activating",
    });
  });

  it("cancels a pending Account reservation before clearing its local journal", async () => {
    const fixture = unlinkFixture(0);
    const operationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    await fixture.links.save(fixture.runtime.discovery.deploymentId, {
      authority: fixture.runtime,
      issueOperationId: operationId,
      operation: null,
      schemaVersion: 4,
      unlinkOperation: null,
    });
    fixture.host.status.mockResolvedValue({
      accountLink: null,
      generation: 0,
      mode: "off",
      route: null,
      schemaVersion: 2,
    });

    await expect(fixture.service.unlink()).resolves.toMatchObject({ status: "unlinked" });
    expect(fixture.account.cancelPersonalHostAccountLinkOperation).toHaveBeenCalledWith(
      operationId,
    );
    await expect(fixture.links.load()).resolves.toBeNull();
  });

  it("cancels an activating link through the Host without running the unlink ladder", async () => {
    const fixture = unlinkFixture(0);
    await fixture.links.clear();
    fixture.startActivating();

    await expect(fixture.service.unlink()).resolves.toMatchObject({ status: "unlinked" });

    // Nothing but the Host link removal: pre-activation there is no Connect
    // route, no Connect resource, and no Account-brokered session to revoke.
    expect(fixture.events).toEqual(["host-link"]);
    expect(fixture.host.removeAccountLinkForUnlink).toHaveBeenCalledOnce();
    await expect(fixture.links.load()).resolves.toBeNull();
    // The wedge this replaces: no unlink journal is ever written, so no later
    // reconcile can find an unlink operation against an activating Host row.
    expect(fixture.links.saved.some((state) => state.unlinkOperation !== null)).toBe(false);
  });

  it("cancels a saved completion the Host never took instead of activating to tear down", async () => {
    const fixture = unlinkFixture(0);
    fixture.clearHostLink();
    const operationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    await fixture.links.save(fixture.runtime.discovery.deploymentId, {
      authority: fixture.runtime,
      issueOperationId: null,
      operation: {
        challenge: fixture.challenge,
        completion: fixture.completion,
        operationId,
        proof: fixture.proof,
      },
      schemaVersion: 4,
      unlinkOperation: null,
    });

    await expect(fixture.service.unlink()).resolves.toMatchObject({ status: "unlinked" });

    expect(fixture.account.cancelPersonalHostAccountLinkOperation).toHaveBeenCalledWith(
      operationId,
    );
    expect(fixture.link.ensureLinkedForMutation).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
    await expect(fixture.links.load()).resolves.toBeNull();
  });

  it("resumes an activating link once for the signed-in Account and never for another", async () => {
    const fixture = unlinkFixture(0);
    await fixture.links.clear();
    fixture.startActivating();

    await expect(fixture.service.resumeActivatingLink()).resolves.toMatchObject({
      status: "activating",
    });
    expect(fixture.link.ensureLinkedForMutation).toHaveBeenCalledOnce();

    const other = unlinkFixture(0);
    await other.links.clear();
    other.startActivating();
    other.account.accountIdentity.mockResolvedValue({
      issuer: "https://another-account.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    });
    await expect(other.service.resumeActivatingLink()).resolves.toBeNull();
    expect(other.link.ensureLinkedForMutation).not.toHaveBeenCalled();

    // An active link has nothing to resume, so startup stays silent.
    const linked = unlinkFixture(0);
    await linked.links.clear();
    await expect(linked.service.resumeActivatingLink()).resolves.toBeNull();
    expect(linked.link.ensureLinkedForMutation).not.toHaveBeenCalled();
  });

  it("discards an unusable journal only while repair is the reported state", async () => {
    const fixture = unlinkFixture(0);
    await expect(fixture.service.resetLinkJournal()).rejects.toThrow("does not need repair");
    await expect(fixture.links.load()).resolves.not.toBeNull();

    fixture.links.readError = new Error("Protected journal cannot be decrypted");
    await expect(fixture.service.resetLinkJournal()).resolves.toMatchObject({ status: "linked" });
    await expect(fixture.links.load()).resolves.toBeNull();

    // A Host that cannot be read cannot license the discard.
    const offline = unlinkFixture(0);
    offline.links.readError = new Error("Protected journal cannot be decrypted");
    offline.host.status.mockRejectedValueOnce(new Error("Host offline"));
    await expect(offline.service.resetLinkJournal()).rejects.toThrow("Host offline");
    await expect(offline.links.load()).resolves.not.toBeNull();
  });

  it("serializes two rapid cancels and a resume racing them", async () => {
    const fixture = unlinkFixture(0);
    await fixture.links.clear();
    fixture.startActivating();

    const [first, second, resumed] = await Promise.allSettled([
      fixture.service.unlink(),
      fixture.service.unlink(),
      fixture.service.resumeActivatingLink(),
    ]);

    expect(first).toMatchObject({ status: "fulfilled", value: { status: "unlinked" } });
    expect(second).toMatchObject({ status: "fulfilled", value: { status: "unlinked" } });
    // The second cancel finds the link already gone and does nothing more.
    expect(fixture.host.removeAccountLinkForUnlink).toHaveBeenCalledOnce();
    // A resume queued behind a cancel is refused rather than re-linking.
    expect(resumed).toMatchObject({
      reason: { code: "personal-account-unlink-in-progress" },
      status: "rejected",
    });
    await expect(fixture.links.load()).resolves.toBeNull();
  });

  it("keeps linked-elsewhere, unavailable, and needs-repair distinct", async () => {
    const fixture = unlinkFixture(0);
    fixture.account.accountIdentity.mockResolvedValueOnce({
      issuer: "https://another-account.opensteer.test",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    });
    await expect(fixture.service.status()).resolves.toMatchObject({
      account: null,
      status: "linked-elsewhere",
    });

    fixture.host.status.mockRejectedValueOnce(new Error("Host offline"));
    await expect(fixture.service.status()).resolves.toMatchObject({ status: "unavailable" });

    fixture.links.needsRepair = true;
    await expect(fixture.service.status()).resolves.toMatchObject({ status: "needs-repair" });

    fixture.links.needsRepair = false;
    fixture.links.readError = new Error("Protected journal cannot be decrypted");
    await expect(fixture.service.status()).resolves.toMatchObject({
      account: fixture.accountIdentity,
      status: "needs-repair",
    });
    await expect(fixture.service.unlink()).rejects.toThrow("cannot be decrypted");
  });
});

function unlinkFixture(boundary: number) {
  const events: string[] = [];
  const deploymentId = createId("deployment");
  const runtime = testPersonalHostRuntime({
    discovery: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
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
  const accountIdentity = {
    issuer: "https://account.opensteer.test",
    subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
  };
  const completedSteps = steps.slice(0, boundary);
  const initialState = DesktopPersonalAccountLinkStateSchema.parse({
    authority: runtime,
    operation: null,
    schemaVersion: 4,
    unlinkOperation:
      boundary === 0
        ? null
        : {
            completedSteps,
            connectRevokeOperationId: `cop_${crypto.randomUUID()}`,
            startedAt: "2026-08-20T12:00:00.000Z",
          },
  });
  const links = new MemoryLinks(initialState);
  let manifest = {
    deploymentId,
    name: boundary >= 4 ? "Account-owned label" : "Local last-known label",
    revision: 3,
    updatedAt: "2026-08-20T12:00:00.000Z",
    workspaceRoot: "/local/workspaces",
  } as PersonalDeploymentManifest;
  const directoryDeployment = AccountDeploymentSchema.parse({
    access: "owner" as const,
    accountLink: {
      generation: "g".repeat(43),
      issuer: accountIdentity.issuer,
      subject: accountIdentity.subject,
    },
    authorityEnvelope: runtime.discoveryEnvelope,
    connectResourceState: "disabled" as const,
    connectRoute: null,
    generation: 1,
    id: deploymentId,
    lastSeenAt: null,
    lifecycle: "active" as const,
    name: "Account-owned label",
    reachability: "routed" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
  });
  const account = {
    accountIdentity: vi.fn(async () => accountIdentity),
    cancelPersonalHostAccountLinkOperation: vi.fn(async () => undefined),
    renamePersonalDeployment: vi.fn(async (_deploymentId: string, name: string) => ({
      ...directoryDeployment,
      name,
    })),
  };
  let hostLink: {
    readonly generation: string;
    readonly issuer: string;
    readonly state: "activating" | "active";
    readonly subject: string;
  } | null =
    boundary > steps.indexOf("remove-host-link")
      ? null
      : {
          ...accountIdentity,
          generation: AccountLinkGenerationSchema.parse("g".repeat(43)),
          state: "active" as const,
        };
  const host = {
    removeAccountLinkForUnlink: vi.fn(async () => {
      events.push("host-link");
      hostLink = null;
    }),
    repairHostedOAuthConnectionsForUnlink: async () => void events.push("oauth"),
    revokeAccountSessionsForUnlink: async () => void events.push("sessions"),
    status: vi.fn(async (): Promise<PersonalRemoteAccessStatus> =>
      PersonalRemoteAccessStatusSchema.parse({
        accountLink: hostLink,
        generation: 0,
        mode: "off" as const,
        route: null,
        schemaVersion: 2 as const,
      }),
    ),
  };
  const link = { ensureLinkedForMutation: vi.fn(async () => initialState) };
  const service = new DesktopPersonalAccountService({
    account,
    host,
    link,
    links,
    manifest: {
      load: async () => manifest,
      save: async (_previous, next) => {
        manifest = next;
        return manifest;
      },
    },
    remote: {
      disableConnectForUnlink: async () => {
        events.push("disable");
        return {} as never;
      },
      revokeConnectResourceForUnlink: async () => void events.push("resource"),
    },
    runtime: { current: async () => runtime },
  });
  const challenge = IssuePersonalHostAccountLinkChallengeResponseSchema.parse({
    account: accountIdentity,
    authorityEnvelope: runtime.discoveryEnvelope,
    challengeCredential: `olc_${"b".repeat(43)}`,
    challengeId: `phc_${crypto.randomUUID()}`,
    expiresAt: "2026-08-20T12:05:00.000Z",
  });
  const proof = PersonalHostAccountLinkProofEnvelopeSchema.parse({
    document: {
      account: accountIdentity,
      authority: runtime.discoveryEnvelope.document,
      challenge: { credentialSha256: "c".repeat(43), id: challenge.challengeId },
      documentVersion: 2,
      expiresAt: "2026-08-20T12:04:00.000Z",
      issuedAt: "2026-08-20T12:00:00.000Z",
      purpose: "opensteer-personal-host-account-link",
    },
    publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
    signature: "A".repeat(86),
  });
  const completion = CompletePersonalHostAccountLinkResponseSchema.parse({
    completionGrant: `${"completion".repeat(4)}.${"e".repeat(32)}.${"f".repeat(32)}`,
    hostCredential: `osc_${"d".repeat(43)}`,
    linkGeneration: "g".repeat(43),
    resultExpiresAt: "2026-08-21T12:00:00.000Z",
  });
  return {
    account,
    challenge,
    completion,
    directoryDeployment,
    events,
    host,
    link,
    proof,
    /** Rewinds the Host to the half-linked state the two-phase link passes
     * through, so a cancel can be exercised before central activation. */
    startActivating: () => {
      hostLink = hostLink && { ...hostLink, state: "activating" as const };
    },
    clearHostLink: () => {
      hostLink = null;
    },
    accountIdentity,
    get manifest() {
      return manifest;
    },
    links,
    initialManifestName: boundary >= 4 ? "Account-owned label" : "Local last-known label",
    privateRoute: "https://studio.tailnet.test",
    runtime,
    service,
    tokens: ["vault-token-kept"],
  };
}

class MemoryLinks {
  needsRepair = false;
  readError: Error | null = null;
  readonly saved: DesktopPersonalAccountLinkState[] = [];
  #state: DesktopPersonalAccountLinkState | null;

  constructor(state: DesktopPersonalAccountLinkState) {
    this.#state = state;
  }

  async load() {
    return this.#state ? structuredClone(this.#state) : null;
  }

  async save(_deploymentId: string, state: DesktopPersonalAccountLinkState) {
    this.#state = DesktopPersonalAccountLinkStateSchema.parse(structuredClone(state));
    this.saved.push(structuredClone(this.#state));
    return structuredClone(this.#state);
  }

  async clear() {
    // Deleting the file removes the read failure with it.
    this.needsRepair = false;
    this.readError = null;
    this.#state = null;
  }

  /** Read-only: an unreadable journal is repairable, never a throw. */
  async inspect(_deploymentId: string, _runtime: unknown, _accountLink: unknown) {
    if (this.readError || this.needsRepair) {
      return { journal: null, status: "needs-repair" as const };
    }
    return { journal: this.#state ? structuredClone(this.#state) : null, status: "ready" as const };
  }

  async reconcileForMutation(_deploymentId: string, _runtime: unknown, _accountLink: unknown) {
    if (this.readError) throw this.readError;
    return {
      journal: this.#state ? structuredClone(this.#state) : null,
      status: this.needsRepair ? ("needs-repair" as const) : ("ready" as const),
    };
  }
}
