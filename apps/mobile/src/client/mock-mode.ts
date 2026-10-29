import {
  DeploymentConnectionInputSchema,
  type DeploymentConnectionInput,
} from "@opensteer/client/connections";
import { DeploymentIdSchema, HostInstanceIdSchema } from "@opensteer/core";

/**
 * Development entry: `EXPO_PUBLIC_OPENSTEER_MOCK=1` runs the app against the
 * in-memory Host, exactly as the web app's `VITE_OPENSTEER_USE_MOCK` does.
 *
 * Whether it is allowed at all is `readMobileConfiguration`'s answer, not this
 * file's: it is read once, at the root, and nothing else in the app knows it
 * exists — no screen branches on it. It exists so the whole interface can be
 * exercised on a simulator with no Host, no network and no sign-in.
 */

const mockOrigin = "https://mock.opensteer.example";
const mockSignedOutOrigin = "https://signed-out.opensteer.example";

/** The Deployment mock mode holds no credential for, so its row needs one. */
export const mockSignedOutDeploymentId = DeploymentIdSchema.parse(
  "dep_0192f4a1-0000-4000-8000-000000000003",
);

/**
 * The rows mock mode starts with: one this phone is signed in to, and one it is
 * not, so both states of a Deployment row — and the action that leads out of
 * the second — can be exercised with no Host and no network. Their authority
 * envelopes are not signed; nothing in mock mode verifies one, and the catalog
 * only verifies signatures on a Personal access route, which neither row has.
 */
export function mockDeploymentConnections(): readonly DeploymentConnectionInput[] {
  return [
    // The in-memory Host's own identity, which the pairing target it hands an
    // iPhone being added names.
    mockConnection({
      deploymentId: "dep_00000000-0000-4000-8000-000000000001",
      hostInstanceId: "hst_00000000-0000-4000-8000-000000000001",
      name: "Mock deployment",
      origin: mockOrigin,
    }),
    mockConnection({
      deploymentId: mockSignedOutDeploymentId,
      hostInstanceId: "hst_0192f4a1-0000-4000-8000-000000000004",
      name: "Mock signed-out server",
      origin: mockSignedOutOrigin,
    }),
  ];
}

function mockConnection(input: {
  readonly deploymentId: string;
  readonly hostInstanceId: string;
  readonly name: string;
  readonly origin: string;
}): DeploymentConnectionInput {
  return DeploymentConnectionInputSchema.parse({
    accountAccess: null,
    authority: {
      document: {
        canonicalOrigin: input.origin,
        deploymentId: DeploymentIdSchema.parse(input.deploymentId),
        deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
        hostInstanceId: HostInstanceIdSchema.parse(input.hostInstanceId),
        hostKey: { algorithm: "Ed25519" },
      },
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      signature: "A".repeat(86),
    },
    bootstrapMethods: ["password"],
    endpoints: [{ kind: "canonical", origin: input.origin, verifiedAt: new Date(0).toISOString() }],
    kind: "self-hosted",
    name: input.name,
    reachability: "canonical",
    source: { kind: "manual" },
  });
}
