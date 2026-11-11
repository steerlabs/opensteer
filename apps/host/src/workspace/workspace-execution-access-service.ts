import { OpensteerError, ProjectRunBindingSchema, type ProjectRunBinding } from "@opensteer/core";
import type { DeploymentShape, EnvironmentId, UserId, Workspace } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  assertExecutionAllowedByDeployment,
  workspaceUsesBacking,
  type WorkspaceExecutionAccessPlan,
} from "@opensteer/workspace";
import type { RunnerLocalWorkspaceDriver } from "./runner-local-workspace-driver.js";

/** Host-side admission and access-plan router for one connected machine. */
export class WorkspaceExecutionAccessService {
  readonly #local: Pick<RunnerLocalWorkspaceDriver, "planExecutionAccess"> | undefined;
  readonly #shape: DeploymentShape;

  constructor(options: {
    readonly local: Pick<RunnerLocalWorkspaceDriver, "planExecutionAccess">;
    readonly shape: DeploymentShape;
  }) {
    this.#local = options.local;
    this.#shape = options.shape;
  }

  async plan(input: {
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runnerIdentity: RunnerIdentity;
    readonly workspace: Workspace;
  }): Promise<WorkspaceExecutionAccessPlan> {
    return this.#planStorage(input);
  }

  async planProject(input: {
    readonly binding: ProjectRunBinding;
    readonly runnerIdentity: RunnerIdentity;
    readonly workspace: Workspace;
  }): Promise<WorkspaceExecutionAccessPlan> {
    const binding = ProjectRunBindingSchema.parse(input.binding);
    if (
      binding.workspaceId !== input.workspace.id ||
      input.workspace.kind !== "project" ||
      binding.runnerId !== input.runnerIdentity.runnerId ||
      binding.runnerBootId !== input.runnerIdentity.bootId
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Project storage address does not match its execution binding",
      });
    return this.#planStorage({
      environmentId: binding.environmentId,
      runnerIdentity: input.runnerIdentity,
      workspace: input.workspace,
    });
  }

  async #planStorage(input: {
    readonly environmentId: EnvironmentId;
    readonly runnerIdentity: RunnerIdentity;
    readonly workspace: Workspace;
  }): Promise<WorkspaceExecutionAccessPlan> {
    if (input.workspace.backing.kind !== "local-directory")
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "Workspace storage requires relocation to a local directory",
      });
    const agents = input.runnerIdentity.modules.agents;
    if (!agents?.workspaceBackings.includes(input.workspace.backing.kind)) {
      throw new Error(`Runner does not support ${input.workspace.backing.kind} Workspace access`);
    }
    assertExecutionAllowedByDeployment({
      backing: input.workspace.backing,
      executionEnvironmentId: input.environmentId,
      shape: this.#shape,
    });
    if (workspaceUsesBacking(input.workspace, "local-directory")) {
      const local = this.#local;
      if (!local) throw new Error("Local Workspace access is not configured");
      return local.planExecutionAccess({
        environmentId: input.environmentId,
        workspace: input.workspace,
      });
    }
    throw new Error("Workspace storage requires relocation");
  }
}
