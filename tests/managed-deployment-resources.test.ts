import { describe, expect, it } from "vitest";
import { managedRunnerEnvironment } from "../apps/control-plane/src/cloud/kubernetes-managed-deployment-resources.js";
describe("managed deployment resources", () => {
  it("configures persistent local directories on the enrolled Runner", () => {
    const environment = Object.fromEntries(
      managedRunnerEnvironment(
        "https://managed.opensteer.test",
        "env_00000000-0000-5000-8000-000000000001",
      ).map((entry) => [entry.name, entry.value]),
    );
    expect(environment).toMatchObject({
      OPENSTEER_ENVIRONMENT_ID: "env_00000000-0000-5000-8000-000000000001",
      OPENSTEER_LOCAL_WORKSPACE_ROOT: "/workspaces",
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/var/lib/opensteer/workspace-bindings.v1.json",
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "local-directory",
    });
  });
});
