import type {
  CommandId,
  ContentPart,
  HumanRoot,
  ProjectRunBinding,
  RunId,
  ThreadId,
  ThreadInput,
  ThreadInputPolicy,
} from "@opensteer/core";
import type { ProjectWorkSource } from "@opensteer/database";
import type {
  ProjectCapabilityClaims,
  ProjectCapabilityScope,
  ProjectExecutableCommand,
  ProjectRunControl,
} from "@opensteer/protocol";

export interface ProjectAdmissionPort {
  admitProjectWork(input: {
    readonly threadId: ThreadId;
    readonly origin: HumanRoot | null;
    readonly source: ProjectWorkSource;
    readonly content: readonly ContentPart[];
    readonly policy: ThreadInputPolicy;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly input: ThreadInput;
    readonly runId: RunId | null;
    readonly commandId: CommandId | null;
  }>;
}

export interface ProjectCapabilityPort {
  assertProjectBinding(scope: ProjectCapabilityScope): Promise<void>;
  issue(scope: ProjectCapabilityScope, audience: ProjectCapabilityClaims["aud"]): Promise<string>;
  verify(token: string, audience: ProjectCapabilityClaims["aud"]): Promise<ProjectCapabilityClaims>;
}

export interface ProjectDispatchPort {
  dispatch(command: ProjectExecutableCommand): Promise<void>;
  control(input: {
    readonly binding: ProjectRunBinding;
    readonly commandId: CommandId;
    readonly correlationId: string;
    readonly control: ProjectRunControl;
  }): Promise<void>;
}

export interface ProjectRecoveryPort {
  recover(input: {
    readonly runId: RunId;
    readonly expectedBindingGeneration: number | null;
  }): Promise<{ readonly state: "recovered" | "cancelled" | "unavailable" }>;
}

export interface ProjectRuntimePorts {
  readonly admission: ProjectAdmissionPort;
  readonly capabilities: ProjectCapabilityPort;
  readonly dispatch: ProjectDispatchPort;
  readonly recovery: ProjectRecoveryPort;
}
