import type { DeploymentShape, ExecutionEnvironmentKind } from "./models.js";

export interface DeploymentPolicy {
  readonly ownership: "single-user" | "members";
  readonly workspaceNamespace: "single-owner" | "owner-scoped";
  readonly sharing: boolean;
  readonly configuration: {
    readonly loopbackOnly: boolean;
    readonly nativeOAuth: boolean;
    readonly accountAttachment: boolean;
  };
  readonly services: { readonly personalRemoteAccess: boolean };
  readonly integrationAccountBinding: "personal-link" | "identity-provider";
  readonly runnerEnrollment:
    | {
        readonly mode: "reach-only";
        readonly reachableModules: readonly ["integrations", "messaging", "shell"];
        readonly supervisedServiceModules: readonly ["integrations", "messaging", "shell"];
      }
    | { readonly mode: "unrestricted" };
  readonly localRunnerDefaultModules: readonly ("agents" | "browser" | "shell")[];
  readonly harnessBoundaries: Readonly<
    Record<ExecutionEnvironmentKind, "native-user" | "isolated-service">
  >;
}

export type DeploymentClientPolicy = Pick<
  DeploymentPolicy,
  "ownership" | "localRunnerDefaultModules"
>;

export function deploymentPolicy(shape: DeploymentShape): DeploymentPolicy {
  if (shape.kind === "personal") {
    return {
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
    };
  }
  return {
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
  };
}

export function deploymentClientPolicy(policy: DeploymentPolicy): DeploymentClientPolicy {
  return {
    ownership: policy.ownership,
    localRunnerDefaultModules: policy.localRunnerDefaultModules,
  };
}
