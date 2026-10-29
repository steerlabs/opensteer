import type { DeploymentShape, EnvironmentId, UserId, Workspace } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  assertExecutionAllowedByDeployment,
  workspaceUsesBacking,
  type WorkspaceExecutionAccessPlan,
} from "@opensteer/workspace";
import { PortableFsWorkspaceExecutionAccessDriver } from "./files/portablefs-workspace-access.js";
import type { RunnerLocalWorkspaceDriver } from "./runner-local-workspace-driver.js";
import type { MountExchangeService } from "../identity/mount-exchange.js";

/** Host-side admission and access-plan router for one connected machine. */
export class WorkspaceExecutionAccessService {
  readonly #local: Pick<RunnerLocalWorkspaceDriver, "planExecutionAccess"> | undefined;
  readonly #portableFs: PortableFsWorkspaceExecutionAccessDriver | undefined;
  readonly #shape: DeploymentShape;

  constructor(options: {
    // Both may be configured at once: a Deployment holds shared storage and the
    // directories of every machine lent to it, and a Run may reach either.
    readonly local?: Pick<RunnerLocalWorkspaceDriver, "planExecutionAccess">;
    readonly portableFs?: {
      readonly exchange: MountExchangeService;
      readonly exchangeUrl: string;
    };
    readonly shape: DeploymentShape;
  }) {
    if (!options.local && !options.portableFs) {
      throw new TypeError("Workspace execution access requires at least one driver");
    }
    if (options.portableFs && options.shape.defaultWorkspaceBacking !== "portablefs") {
      throw new TypeError("PortableFS access requires a PortableFS Deployment default");
    }
    this.#local = options.local;
    this.#portableFs = options.portableFs
      ? new PortableFsWorkspaceExecutionAccessDriver(options.portableFs)
      : undefined;
    this.#shape = options.shape;
  }

  async plan(input: {
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runnerIdentity: RunnerIdentity;
    readonly workspace: Workspace;
  }): Promise<WorkspaceExecutionAccessPlan> {
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
    if (!workspaceUsesBacking(input.workspace, "portablefs")) {
      throw new Error("Workspace backing is not supported");
    }
    const portableFs = this.#portableFs;
    if (!portableFs) throw new Error("PortableFS Workspace access is not configured");
    return portableFs.planExecutionAccess({
      environmentId: input.environmentId,
      membershipGeneration: input.membershipGeneration,
      requestedBy: input.requestedBy,
      runnerIdentity: input.runnerIdentity,
      workspace: input.workspace,
    });
  }
}
