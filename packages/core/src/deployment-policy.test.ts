import { describe, expect, it } from "vitest";
import { deploymentPolicy } from "./deployment-policy.js";

describe("deployment policy", () => {
  it.each([
    {
      kind: "personal" as const,
      expected: {
        ownership: "single-user",
        workspaceNamespace: "single-owner",
        sharing: false,
        configuration: { loopbackOnly: true, nativeOAuth: false, accountAttachment: false },
        services: { personalRemoteAccess: true },
        integrationAccountBinding: "personal-link",
        runnerEnrollment: {
          mode: "reach-only",
          reachableModules: ["integrations", "messaging", "shell"],
          supervisedServiceModules: ["integrations", "messaging", "shell"],
        },
        localRunnerDefaultModules: ["shell"],
        harnessBoundaries: { main: "native-user", local: "native-user", managed: "native-user" },
      },
    },
    {
      kind: "server" as const,
      expected: {
        ownership: "members",
        workspaceNamespace: "owner-scoped",
        sharing: true,
        configuration: { loopbackOnly: false, nativeOAuth: true, accountAttachment: true },
        services: { personalRemoteAccess: false },
        integrationAccountBinding: "identity-provider",
        runnerEnrollment: { mode: "unrestricted" },
        localRunnerDefaultModules: ["agents", "browser", "shell"],
        harnessBoundaries: {
          main: "isolated-service",
          local: "native-user",
          managed: "isolated-service",
        },
      },
    },
  ])("pins every current $kind fact", ({ kind, expected }) => {
    expect(deploymentPolicy({ kind, defaultWorkspaceBacking: "local-directory" })).toEqual(
      expected,
    );
  });
});
