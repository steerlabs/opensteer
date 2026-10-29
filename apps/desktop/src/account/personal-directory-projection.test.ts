import {
  AccountDeploymentDirectoryEntrySchema,
  ControlPlaneAccountIdSchema,
  type AccountDeploymentDirectoryEntry,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import type { AccountDeploymentConnectionSource } from "@opensteer/client/connections";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "@opensteer/client/test-support";
import type { HostDiscoveryDocument } from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import { DesktopPersonalAccountMutationCoordinator } from "./personal-account-mutation.js";
import { DesktopPersonalDirectoryProjection } from "./personal-directory-projection.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";

const keys = testHostAuthorityKeys();
const canonicalOrigin = "http://127.0.0.1:4310";
const deploymentId = createId("deployment");
const source: AccountDeploymentConnectionSource = {
  issuer: "https://accounts.opensteer.test",
  kind: "account",
  subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
};
const discovery: HostDiscoveryDocument = {
  canonicalOrigin,
  deploymentId,
  deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
  hostInstanceId: createId("hostInstance"),
  hostKey: { algorithm: "Ed25519" },
};

describe("DesktopPersonalDirectoryProjection", () => {
  /**
   * Naming the local Personal Host after its Account listing is best-effort
   * local metadata maintenance. A Host that stopped or a protected journal
   * this release cannot read must never turn linked into unlinked, and must
   * never fail the directory sync that carries every other Deployment.
   */
  it.each(["host", "journal"] as const)(
    "swallows a local Personal %s read failure without touching the manifest",
    async (failure) => {
      const deployment = routedDeployment();
      if (deployment.reachability !== "routed") throw new Error("Expected a routed fixture.");
      const inspect = vi.fn();
      const load = vi.fn();
      const save = vi.fn();
      if (failure === "journal") {
        inspect.mockRejectedValueOnce(new Error("Protected journal cannot be decrypted"));
      }
      const projection = new DesktopPersonalDirectoryProjection({
        host: {
          status: vi.fn(async () => {
            if (failure === "host") throw new Error("Host stopped");
            return {
              accountLink: { ...deployment.accountLink, state: "active" as const },
              generation: 0,
              mode: "off" as const,
              route: null,
              schemaVersion: 2 as const,
            };
          }),
        },
        links: { inspect },
        manifest: { load, save },
        mutations: new DesktopPersonalAccountMutationCoordinator(),
        runtime: {
          current: async () =>
            testPersonalHostRuntime({
              discovery,
              localOrigin: canonicalOrigin,
              observedAt: "2026-08-11T20:00:00.000Z",
              ownership: "desktop-personal-host-supervisor",
              state: "ready",
              verification: "signed-loopback-discovery",
            }),
        },
      });

      await expect(
        projection.project(deployment, source, new AbortController().signal),
      ).resolves.toBeUndefined();

      expect(inspect).toHaveBeenCalledTimes(failure === "journal" ? 1 : 0);
      expect(load).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );
});

function accountLink() {
  return { generation: "a".repeat(43), issuer: source.issuer, subject: source.subject };
}

function routedDeployment(): AccountDeploymentDirectoryEntry {
  return AccountDeploymentDirectoryEntrySchema.parse({
    access: "owner",
    accountLink: accountLink(),
    authority: {
      canonicalOrigin,
      deploymentId,
      hostInstanceId: discovery.hostInstanceId,
      hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
    },
    authorityEnvelope: signTestDiscoveryEnvelope(discovery, keys),
    connectResourceState: "ready",
    connectRoute: connectRoute(),
    generation: 1,
    id: deploymentId,
    lastSeenAt: {
      expiresAt: "2099-08-11T20:02:00.000Z",
      observedAt: "2026-08-11T20:00:00.000Z",
    },
    lifecycle: "active",
    name: "Studio Mac",
    reachability: "routed",
    updatedAt: "2026-08-11T20:00:00.000Z",
  });
}

function connectRoute(): PersonalHostAccessRouteEnvelope {
  return signTestPersonalAccessRoute(
    {
      authority: discovery,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: { generation: 1, kind: "connect", origin: "https://studio.connect.opensteer.test" },
    },
    keys,
  );
}
