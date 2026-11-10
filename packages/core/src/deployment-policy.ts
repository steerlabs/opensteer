import type { DeploymentShape, ExecutionEnvironmentKind } from "./models.js";

export interface DeploymentPolicy {
  readonly ownership: "single-user" | "members";
  readonly workspaceNamespace: "single-owner" | "owner-scoped";
  readonly sharing: boolean;
  readonly deploymentWideMachineReach: boolean;
  readonly appOrigins: "real" | "isolated";
  readonly executionPrincipal: "person" | "project";
  readonly executionAccess: "administrator" | "member";
  readonly projectConsent: "owner-wide" | "per-project";
  readonly browserHomesOnDeploymentComputers: "main-only" | "all";
  readonly nativePasswords: boolean;
  readonly nativeWebLinks: boolean;
  readonly serviceManagement: boolean;
  readonly deploymentComputerAccess: boolean;
  readonly deploymentOwnsMainComputer: boolean;
  readonly computerExecutionControls: boolean;
  readonly loopbackOriginAliases: boolean;
  readonly retainLocalIntegrationApproval: boolean;
  readonly configuration: {
    readonly loopbackOnly: boolean;
    readonly nativeOAuth: boolean;
    readonly accountAttachment: boolean;
    readonly localOwnerClaim: boolean;
    readonly packagedWebDistribution: boolean;
    readonly personalAccountIssuer: boolean;
    readonly explicitIdentityWithoutAccount: boolean;
    readonly insecureLoopbackOrigins: boolean;
    readonly externalRunners: boolean;
    readonly serverTooling: boolean;
    readonly knowledgeTrial: boolean;
  };
  readonly services: {
    readonly personalRemoteAccess: boolean;
    readonly localBrowserProfileInventory: boolean;
    readonly managedBrowserEnrollment: boolean;
  };
  readonly integrationAccountBinding: "personal-link" | "identity-provider";
  readonly runnerEnrollment:
    | {
        readonly mode: "reach-only";
        readonly reachableModules: readonly ["browser", "integrations", "messaging", "shell"];
        readonly supervisedServiceModules: readonly ["integrations", "messaging", "shell"];
      }
    | { readonly mode: "unrestricted" };
  readonly localRunnerDefaultModules: readonly (
    "agents" | "browser" | "integrations" | "messaging" | "shell"
  )[];
  readonly harnessBoundaries: Readonly<
    Record<ExecutionEnvironmentKind, "native-user" | "isolated-service">
  >;
}

type DeploymentClientFacts = {
  readonly personalRemoteAccess: boolean;
  readonly localOwnerClaim: boolean;
  readonly runnerEnrollmentMode: DeploymentPolicy["runnerEnrollment"]["mode"];
} & Pick<
  DeploymentPolicy,
  | "ownership"
  | "localRunnerDefaultModules"
  | "nativePasswords"
  | "nativeWebLinks"
  | "deploymentOwnsMainComputer"
  | "deploymentComputerAccess"
  | "computerExecutionControls"
  | "projectConsent"
  | "sharing"
  | "deploymentWideMachineReach"
  | "serviceManagement"
>;

export type DeploymentClientPolicy = {
  readonly [Fact in keyof DeploymentClientFacts]?: DeploymentClientFacts[Fact] | undefined;
};

export function deploymentPolicy(shape: DeploymentShape): DeploymentPolicy {
  if (shape.kind === "personal") {
    return {
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
      integrationAccountBinding: "personal-link",
      runnerEnrollment: {
        mode: "reach-only",
        reachableModules: ["browser", "integrations", "messaging", "shell"],
        supervisedServiceModules: ["integrations", "messaging", "shell"],
      },
      localRunnerDefaultModules: ["browser", "integrations", "messaging", "shell"],
      harnessBoundaries: { main: "native-user", local: "native-user", managed: "native-user" },
    };
  }
  if (shape.kind === "server")
    return {
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
      integrationAccountBinding: "identity-provider",
      runnerEnrollment: { mode: "unrestricted" },
      localRunnerDefaultModules: ["agents", "browser", "shell"],
      harnessBoundaries: {
        main: "isolated-service",
        local: "native-user",
        managed: "isolated-service",
      },
    };
  const unknownKind: never = shape.kind;
  throw new Error(`Unknown Deployment kind: ${String(unknownKind)}`);
}

export function deploymentClientPolicy(policy: DeploymentPolicy): DeploymentClientPolicy {
  return {
    ownership: policy.ownership,
    runnerEnrollmentMode: policy.runnerEnrollment.mode,
    sharing: policy.sharing,
    deploymentWideMachineReach: policy.deploymentWideMachineReach,
    serviceManagement: policy.serviceManagement,
    personalRemoteAccess: policy.services.personalRemoteAccess,
    nativePasswords: policy.nativePasswords,
    nativeWebLinks: policy.nativeWebLinks,
    deploymentOwnsMainComputer: policy.deploymentOwnsMainComputer,
    localOwnerClaim: policy.configuration.localOwnerClaim,
    deploymentComputerAccess: policy.deploymentComputerAccess,
    computerExecutionControls: policy.computerExecutionControls,
    projectConsent: policy.projectConsent,
    localRunnerDefaultModules: policy.localRunnerDefaultModules,
  };
}
