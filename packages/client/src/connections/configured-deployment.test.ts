import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ensureConfiguredDeployment } from "./configured-deployment.js";
import { emptyDeploymentCatalog, type DeploymentConnectionInput } from "./deployment-catalog.js";
import { testDiscoveryEnvelope } from "../test-support/index.js";

// The application derives this from the computer's name; the caller passes it
// in, so this module never learns the machine it runs on.
const personalDeploymentName = "Studio Mac";

describe("ensureConfiguredDeployment", () => {
  it("discovers and inserts one configured Host only into a fresh catalog", async () => {
    const deploymentId = createId("deployment");
    const upsert = vi.fn(async (_input: DeploymentConnectionInput) => emptyDeploymentCatalog());
    const verify = vi.fn(async (origin: string) => {
      const discovery = {
        canonicalOrigin: origin,
        deploymentId,
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" as const },
        deploymentShape: {
          defaultWorkspaceBacking: "local-directory" as const,
          kind: "personal" as const,
        },
      };
      return {
        bootstrapMethods: [],
        capabilities: [],
        discovery,
        discoveryEnvelope: testDiscoveryEnvelope(discovery),
        endpoint: {
          kind: "canonical" as const,
          origin,
          verifiedAt: "2026-08-11T10:00:00.000Z",
        },
      };
    });

    await ensureConfiguredDeployment({
      catalog: { load: async () => emptyDeploymentCatalog(), upsert },
      hostUrl: new URL("http://127.0.0.1:4310"),
      personalDeploymentName: personalDeploymentName,
      verify,
    });

    expect(verify).toHaveBeenCalledWith("http://127.0.0.1:4310");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "personal" as const,
        name: personalDeploymentName,
        source: { kind: "manual" },
      }),
    );
    expect(upsert.mock.calls[0]?.[0]?.authority.document.deploymentId).toBe(deploymentId);
  });

  it("does not let configured legacy state overwrite an existing catalog", async () => {
    const load = vi.fn(async () => ({
      ...emptyDeploymentCatalog(),
      deployments: [{}],
    }));
    const upsert = vi.fn();
    const verify = vi.fn();

    await ensureConfiguredDeployment({
      catalog: { load, upsert } as never,
      hostUrl: new URL("https://configured.example.test"),
      personalDeploymentName: personalDeploymentName,
      verify,
    });

    expect(verify).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
