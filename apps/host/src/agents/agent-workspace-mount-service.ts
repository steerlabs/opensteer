import { CommandIdSchema, type Workspace } from "@opensteer/core";
import { CorrelationIdSchema, type RunnerCommand } from "@opensteer/protocol";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { AgentControlRunScope, AgentWorkspaceMountService } from "./agent-control-service.js";
import type { WorkspaceExecutionAccessService } from "../workspace/workspace-execution-access-service.js";
import type { WorkspaceActivityService } from "../workspace/workspace-activity.js";

const mountCommandDeadlineMs = 2 * 60 * 1_000;

export class RunnerAgentWorkspaceMountService implements AgentWorkspaceMountService {
  readonly #activity: Pick<WorkspaceActivityService, "note"> | undefined;
  readonly #runners: RunnerRegistry;
  readonly #workspaceAccess: WorkspaceExecutionAccessService;

  constructor(options: {
    readonly activity?: Pick<WorkspaceActivityService, "note">;
    readonly runners: RunnerRegistry;
    readonly workspaceAccess: WorkspaceExecutionAccessService;
  }) {
    this.#activity = options.activity;
    this.#runners = options.runners;
    this.#workspaceAccess = options.workspaceAccess;
  }

  async mount(input: {
    readonly requestId: string;
    readonly scope: AgentControlRunScope;
    readonly workspace: Workspace;
  }): Promise<{ readonly path: string }> {
    const { scope, workspace } = input;
    const identity = this.#runners.identityForEnvironment(scope.environmentId);
    if (
      !identity ||
      identity.runnerId !== scope.runnerId ||
      identity.bootId !== scope.runnerBootId
    ) {
      throw new Error("The Runner for this Main run is no longer connected");
    }
    this.#activity?.note(workspace.id);

    const commandId = CommandIdSchema.parse(`cmd_${input.requestId}`);
    const plan = await this.#workspaceAccess.plan({
      environmentId: scope.environmentId,
      membershipGeneration: scope.membershipGeneration,
      requestedBy: scope.requestedBy,
      runnerIdentity: identity,
      workspace,
    });
    const command: RunnerCommand = {
      commandId,
      correlationId: CorrelationIdSchema.parse(commandId),
      environmentId: scope.environmentId,
      plan,
      runId: scope.runId,
      threadId: scope.threadId,
      type: "workspace.mount",
      workspaceId: workspace.id,
    };
    const accepted = await this.#runners.dispatch(
      command,
      AbortSignal.timeout(mountCommandDeadlineMs),
    );
    if (!accepted.workspacePath) {
      throw new Error("Runner accepted Workspace access without returning its resolved path");
    }
    return { path: accepted.workspacePath };
  }
}
