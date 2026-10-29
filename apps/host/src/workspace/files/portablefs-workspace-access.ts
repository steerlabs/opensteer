import type { EnvironmentId, PortableFsWorkspaceBacking, UserId, Workspace } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import type { PortableFsWorkspaceExecutionAccessPlan } from "@opensteer/workspace";
import type { MountExchangeService } from "../../identity/mount-exchange.js";

type PortableFsWorkspace = Workspace & { readonly backing: PortableFsWorkspaceBacking };

/** Host-side PortableFS plan issuer for one member on one connected machine. */
export class PortableFsWorkspaceExecutionAccessDriver {
  readonly kind = "portablefs" as const;
  readonly #exchange: MountExchangeService;
  readonly #exchangeUrl: string;

  constructor(options: { readonly exchange: MountExchangeService; readonly exchangeUrl: string }) {
    this.#exchange = options.exchange;
    this.#exchangeUrl = options.exchangeUrl;
  }

  async planExecutionAccess(input: {
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runnerIdentity: RunnerIdentity;
    readonly workspace: PortableFsWorkspace;
  }): Promise<PortableFsWorkspaceExecutionAccessPlan> {
    return {
      createdBy: input.workspace.createdBy,
      exchangeToken: await this.#exchange.issue(input),
      exchangeUrl: this.#exchangeUrl,
      generation: input.workspace.backing.generation,
      kind: "portablefs",
      volumeId: input.workspace.backing.volumeId,
      workspaceId: input.workspace.id,
      workspaceKind: input.workspace.kind,
    };
  }
}
