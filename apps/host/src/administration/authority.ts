import { z } from "zod";
import {
  OpensteerError,
  type EnvironmentId,
  type ExecutionEnvironmentKind,
  type RunnerId,
  type UserId,
  type Workspace,
} from "@opensteer/core";
import {
  machineIsManagedBy,
  type HarnessInstanceRecord,
  type OpensteerStore,
} from "@opensteer/database";
import {
  HarnessModelSettingsMapSchema,
  workspaceViewFromWorkspace,
  type WorkspaceView,
} from "@opensteer/protocol";
import type { WorkspaceService } from "../workspace/workspace-service.js";
const maxRunnerOwnershipPages = 50;
const runnerOwnershipPageSize = 100;
export async function boundRunnerEnvironmentIds(
  store: OpensteerStore,
  userId: UserId,
): Promise<ReadonlySet<EnvironmentId>> {
  const bound = new Set<EnvironmentId>();
  let after: RunnerId | undefined;
  for (let page = 0; page < maxRunnerOwnershipPages; page += 1) {
    const listed = await store.listRunners({
      ...(after ? { after } : {}),
      includeDeployment: false,
      limit: runnerOwnershipPageSize,
      ownerId: userId,
    });
    for (const runner of listed.runners) {
      if (runner.ownerUserId !== userId) continue;
      for (const environmentId of runner.environmentIds) bound.add(environmentId);
    }
    if (!listed.nextCursor) break;
    after = listed.nextCursor;
  }
  return bound;
}

export function harnessView(harness: HarnessInstanceRecord) {
  const modelConfig = z
    .object({ models: HarnessModelSettingsMapSchema.optional() })
    .safeParse(harness.config);
  return {
    ...(modelConfig.success && modelConfig.data.models
      ? { modelSettings: modelConfig.data.models }
      : {}),
    config: harness.config,
    driverKind: harness.driverKind,
    enabled: harness.enabled,
    environmentId: harness.environmentId,
    id: harness.id,
    isDefault: harness.isDefault,
    name: harness.name,
    runtimeRevision: harness.runtimeRevision,
    sourceId: harness.sourceId,
    stateKind: harness.stateKind,
  };
}

export function harnessAuthenticationIsAllowed(input: {
  readonly boundEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly environment: { readonly id: EnvironmentId; readonly kind: ExecutionEnvironmentKind };
  readonly isInstanceAdministrator: boolean;
}): boolean {
  return input.isInstanceAdministrator || input.boundEnvironmentIds.has(input.environment.id);
}

// Reach does not confer management: private settings belong to the effective
// owner. Administrators stand in only for Deployment-owned computers.
export async function requireMachineAccessManagement(
  store: OpensteerStore,
  actor: { readonly userId: UserId; readonly isAdministrator: boolean },
  runnerId: RunnerId,
): Promise<void> {
  const ownership = await store.effectiveMachineOwner(runnerId);
  if (!ownership)
    throw new OpensteerError({ code: "not_found", message: "Active Runner not found" });
  if (
    machineIsManagedBy(ownership, actor.userId, {
      allowDeployment: actor.isAdministrator,
    })
  ) {
    return;
  }
  throw new OpensteerError({
    code: "forbidden",
    message: "Only this computer's owner can change how other computers reach it",
  });
}

export function workspaceView(
  service: WorkspaceService,
  workspace: Workspace,
): Promise<WorkspaceView> {
  return typeof service.workspaceView === "function"
    ? service.workspaceView(workspace)
    : Promise.resolve(workspaceViewFromWorkspace(workspace));
}
