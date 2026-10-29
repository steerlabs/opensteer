import { ManagedHostProvisioningBundleSchema } from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { AdoptionOperationCipher } from "./adoption-operation-crypto.js";

describe("AdoptionOperationCipher", () => {
  it("seals credentials at rest and binds the ciphertext to one proof ID", () => {
    const cipher = new AdoptionOperationCipher("A".repeat(43));
    const bundle = ManagedHostProvisioningBundleSchema.parse({
      controlApiOrigin: "https://accounts.example.test",
      deployment: {
        canonicalOrigin: "https://host.example.test",
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
        reachability: "canonical",
      },
      hostCredential: `osc_${"B".repeat(43)}`,
      oidc: {
        clientId: "opensteer-host-deployment",
        issuer: "https://accounts.example.test",
        redirectUri: "https://host.example.test/v1/auth/oidc/callback",
        requirePkce: true,
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      oidcClientSecret: `ocs_${"C".repeat(43)}`,
      provisioningMode: "adoption",
    });
    const proofId = `hap_${crypto.randomUUID()}`;
    const sealed = cipher.seal(proofId, bundle);
    expect(sealed).not.toContain(bundle.hostCredential);
    expect(cipher.open(proofId, sealed)).toEqual(bundle);
    expect(() => cipher.open(`hap_${crypto.randomUUID()}`, sealed)).toThrow();
  });
});
