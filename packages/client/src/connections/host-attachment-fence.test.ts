import { createId } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { DeploymentCatalogSchema, DeploymentConnectionSchema } from "./deployment-catalog.js";
import { HostAttachmentFence } from "./host-attachment-fence.js";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "../test-support/host-authority.js";

function connection(origin: string) {
  const keys = testHostAuthorityKeys();
  const authority = signTestDiscoveryEnvelope(
    {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
      hostKey: { algorithm: "Ed25519" },
    },
    keys,
  );
  const now = new Date().toISOString();
  return DeploymentConnectionSchema.parse({
    authority,
    bootstrapMethods: ["connect-grant"],
    endpoints: [{ kind: "direct", origin, verifiedAt: now }],
    kind: "personal",
    reachability: "routed",
    personalAccessRoute: signTestPersonalAccessRoute(
      {
        authority: authority.document,
        documentVersion: 2,
        purpose: "opensteer-personal-access-route",
        route: { generation: 1, kind: "connect", origin },
      },
      keys,
    ),
    preferredEndpointOrigin: origin,
    source: { kind: "manual" },
    name: "Mac",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  });
}

it("keeps a newer attachment when an older read finishes after it", async () => {
  const first = connection("https://first.connect.opensteer.test");
  const second = connection("https://second.connect.opensteer.test");
  const firstId = first.authority.document.deploymentId;
  let selected = first;
  const { promise: credentialRead, resolve: readCredential } = Promise.withResolvers<string>();
  const { promise: stalled, resolve: stall } = Promise.withResolvers<void>();
  let holdFirst = false;
  const fence = new HostAttachmentFence({
    catalog: {
      load: async () =>
        DeploymentCatalogSchema.parse({
          deployments: [first, second],
          selectedDeploymentId: selected.authority.document.deploymentId,
          revision: 1,
          schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
          updatedAt: new Date().toISOString(),
        }),
      subscribe: () => () => undefined,
    },
    credentials: {
      authorizationHeader: async (target) => {
        if (holdFirst && target.authority.document.deploymentId === firstId) {
          holdFirst = false;
          stall();
          return credentialRead;
        }
        return "PersonalRemote owner-session";
      },
    },
    localRuntime: { current: async () => null },
  });
  let invalidations = 0;
  fence.onInvalidated(() => (invalidations += 1));
  await fence.current();
  await fence.current();
  expect(invalidations).toBe(0);
  holdFirst = true;
  const slow = fence.current();
  await withTimeout(stalled, 3_000, {
    timeoutError: () => new Error("The first read never reached its credentials"),
  });
  selected = second;
  const newest = await fence.current();
  const generation = fence.generation;
  readCredential("PersonalRemote owner-session");
  expect((await slow).resolved.key).toBe(newest.resolved.key);
  expect(fence.currentKey()).toBe(newest.resolved.key);
  expect(fence.generation).toBe(generation);
  expect(invalidations).toBe(1);
});
