import { describe, expect, it } from "vitest";
import { managedRunnerEnvironment } from "../apps/control-plane/src/cloud/kubernetes-managed-deployment-resources.js";
import { portableFsArtifactEnvironmentVariables } from "../deploy/container/opensteer-entrypoint.mjs";

describe("managed deployment resources", () => {
  it("supplies every PortableFS artifact variable the container entrypoint requires", () => {
    const environment = managedRunnerEnvironment(
      "https://managed.opensteer.test",
      `sha256:${"9".repeat(64)}`,
    );
    const byName = new Map(environment.map((entry) => [entry.name, entry.value]));

    for (const variable of portableFsArtifactEnvironmentVariables) {
      expect(byName.has(variable), `${variable} is emitted`).toBe(true);
    }
    expect(byName.get("OPENSTEER_PORTABLEFS_MOUNT_SHA256")).toBe("9".repeat(64));
  });
});
