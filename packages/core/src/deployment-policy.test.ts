import { describe, expect, it } from "vitest";
import { deploymentPolicy } from "./deployment-policy.js";

describe("deployment policy", () => {
  it.each(["future", undefined, null])("refuses an unknown kind: %s", (kind) => {
    expect(() =>
      deploymentPolicy({
        kind,
        defaultWorkspaceBacking: "local-directory",
      } as unknown as Parameters<typeof deploymentPolicy>[0]),
    ).toThrow("Unknown Deployment kind");
  });
  it.each([
    {
      kind: "personal" as const,
      expected: {
        ownership: "single-user",
        workspaceNamespace: "single-owner",
        sharing: false,
        deploymentWideMachineReach: false,
        appOrigins: "real",
        executionPrincipal: "person",
        executionAccess: "administrator",
        projectConsent: "owner-wide",
        browserHomesOnDeploymentComputers: "main-only",
        nativePasswords: true,
        nativeWebLinks: true,
        serviceManagement: false,
        deploymentComputerAccess: true,
        deploymentOwnsMainComputer: true,
        computerExecutionControls: false,
        loopbackOriginAliases: true,
        retainLocalIntegrationApproval: true,
        configuration: {
          loopbackOnly: true,
          nativeOAuth: false,
          accountAttachment: false,
          localOwnerClaim: true,
          packagedWebDistribution: true,
          personalAccountIssuer: true,
          explicitIdentityWithoutAccount: true,
          insecureLoopbackOrigins: true,
          externalRunners: false,
          serverTooling: false,
          knowledgeTrial: true,
        },
        services: {
          personalRemoteAccess: true,
          localBrowserProfileInventory: true,
          managedBrowserEnrollment: false,
        },
        team: { guests: false },
        integrationAccountBinding: "personal-link",
        runnerEnrollment: {
          mode: "reach-only",
          reachableModules: ["browser", "integrations", "messaging", "shell"],
          supervisedServiceModules: ["integrations", "messaging", "shell"],
        },
        localRunnerDefaultModules: ["browser", "integrations", "messaging", "shell"],
        harnessBoundaries: { main: "native-user", local: "native-user", managed: "native-user" },
      },
    },
    {
      kind: "server" as const,
      expected: {
        ownership: "members",
        workspaceNamespace: "owner-scoped",
        sharing: true,
        deploymentWideMachineReach: true,
        appOrigins: "isolated",
        executionPrincipal: "person",
        executionAccess: "member",
        projectConsent: "per-project",
        browserHomesOnDeploymentComputers: "all",
        nativePasswords: false,
        nativeWebLinks: false,
        serviceManagement: true,
        deploymentComputerAccess: false,
        deploymentOwnsMainComputer: false,
        computerExecutionControls: true,
        loopbackOriginAliases: false,
        retainLocalIntegrationApproval: false,
        configuration: {
          loopbackOnly: false,
          nativeOAuth: true,
          accountAttachment: true,
          localOwnerClaim: false,
          packagedWebDistribution: false,
          personalAccountIssuer: false,
          explicitIdentityWithoutAccount: false,
          insecureLoopbackOrigins: false,
          externalRunners: true,
          serverTooling: true,
          knowledgeTrial: false,
        },
        services: {
          personalRemoteAccess: false,
          localBrowserProfileInventory: false,
          managedBrowserEnrollment: true,
        },
        team: { guests: false },
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
