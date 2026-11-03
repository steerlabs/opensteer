import { OpensteerError, type AgentEvent, type WorkspaceId, TimeZoneSchema } from "@opensteer/core";
import {
  createMemoryPass,
  missingMemoryPassMains,
  withDatabaseOperationSignal,
  type OpensteerStore,
} from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { TriggerSystemRole } from "@opensteer/triggers";
import type { WorkspaceFilesService } from "../workspace/files/workspace-files-service.js";
import { matchModelSelection, storedModelSelection } from "./model-selection.js";
import { memoryPassProgram } from "./memory-pass-program.js";
import { triggerProgramCompatibilityReason } from "../triggers/trigger-program-compatibility.js";

export const memoryLightModelPauseReason =
  "This engine has no light model. Choose a model for the light pass, then resume.";

interface MemoryPassServiceOptions {
  readonly store: OpensteerStore;
  readonly runners: Pick<RunnerRegistry, "isAvailable" | "canRunHarness" | "harnessAccessModes">;
  readonly files: Pick<WorkspaceFilesService, "preview">;
  readonly onEvent: (event: AgentEvent) => void;
  readonly onChanged: (workspaceId: WorkspaceId) => void;
  readonly onError: (workspaceId: WorkspaceId, error: unknown) => void;
  readonly batchSize?: number;
}

/** Uses the Workspace reconciliation clock; each candidate advances even when deferred. */
export class MemoryPassService {
  #after: WorkspaceId | undefined;
  readonly #options: MemoryPassServiceOptions;
  constructor(options: MemoryPassServiceOptions) {
    this.#options = options;
  }

  async reconcileMissing(): Promise<void> {
    const { store, batchSize = 20 } = this.#options;
    const candidates = await missingMemoryPassMains(store.database, this.#after, batchSize);
    for (const { id } of candidates) {
      this.#after = id;
      try {
        const expiresAt = Date.now() + 15_000;
        await withDatabaseOperationSignal(AbortSignal.timeout(15_000), expiresAt, () =>
          this.ensureForMain(id),
        );
      } catch (error) {
        if (
          error instanceof OpensteerError &&
          ["conflict", "forbidden", "not_found", "unavailable"].includes(error.code)
        )
          continue;
        this.#options.onError(id, error);
      }
    }
    if (candidates.length < batchSize) this.#after = undefined;
  }

  async ensureForMain(workspaceId: WorkspaceId): Promise<void> {
    const { store, runners, files } = this.#options;
    const present = await store.database
      .selectFrom("triggers")
      .select("systemRole")
      .where("workspaceId", "=", workspaceId)
      .where("systemRole", "is not", null)
      .execute();
    const missing = (["memory-light", "memory-nightly"] as const).filter(
      (role) => !present.some(({ systemRole }) => systemRole === role),
    );
    if (!missing.length) return;
    const workspace = await store.getWorkspace(workspaceId);
    if (
      !workspace ||
      workspace.kind !== "main" ||
      workspace.status !== "ready" ||
      !workspace.homeThreadId
    )
      return;
    const zone = TimeZoneSchema.safeParse(
      await store.notificationState.timeZoneFor(workspace.createdBy),
    );
    if (!zone.success) return;
    const chat = await store.getThreadForOwner(workspace.homeThreadId, workspace.createdBy);
    if (!chat || chat.capabilityProfileId !== "main") return;
    const harness = await store.getHarnessInstance(chat.harnessInstanceId);
    if (
      !harness?.enabled ||
      harness.environmentId !== chat.environmentId ||
      !runners.isAvailable(chat.environmentId) ||
      !runners.canRunHarness(chat.environmentId, harness.driverKind)
    )
      return;
    const modes = runners.harnessAccessModes(chat.environmentId, harness.driverKind);
    if (!modes?.includes(chat.accessMode)) return;
    if (await triggerProgramCompatibilityReason(store, chat.environmentId, 3)) return;
    const catalog = await store.getHarnessCatalog(chat.environmentId, harness.id);
    if (
      catalog?.status !== "ready" ||
      matchModelSelection(catalog.models, chat.modelSelection, "carry").kind !== "offered"
    )
      return;
    const admission = await store.admitWorkspaceFiles(workspace.id, workspace.createdBy);
    if (!admission) return;
    let off = false;
    try {
      const file = await files.preview(
        admission,
        Buffer.from("AGENTS.md").toString("base64url"),
        AbortSignal.timeout(10_000),
      );
      if (file.metadata.truncated) return;
      off = /^Memory: off at the person's request/mu.test(Buffer.from(file.bytes).toString("utf8"));
    } catch (error) {
      if (!(error instanceof OpensteerError) || error.code !== "not_found") return;
    }
    for (const systemRole of missing) {
      const light = systemRole === "memory-light";
      const selection = light ? catalog.lightModel : undefined;
      const match = selection ? matchModelSelection(catalog.models, selection, "refuse") : null;
      if (selection && match?.kind !== "offered") continue;
      const created = await createMemoryPass(store.database, {
        workspaceId,
        ownerId: workspace.createdBy,
        chat,
        catalog,
        runtimeRevision: harness.runtimeRevision,
        systemRole,
        modelSelection:
          selection && match?.kind === "offered"
            ? storedModelSelection(selection, match.model)
            : chat.modelSelection,
        program: memoryPassProgram(systemRole),
        source: memoryPassSource(systemRole, zone.data),
        pauseReason: off
          ? light && !selection
            ? `Memory is off at your request. ${memoryLightModelPauseReason}`
            : "Memory is off at your request."
          : light && !selection
            ? memoryLightModelPauseReason
            : null,
      });
      if (created) {
        if (created.event) this.#options.onEvent(created.event);
        this.#options.onChanged(workspaceId);
      }
    }
  }
}

function memoryPassSource(role: TriggerSystemRole, timezone: string) {
  return {
    kind: "schedule",
    schedule: {
      kind: "cron",
      expression: role === "memory-light" ? "*/30 8-22 * * *" : "0 3 * * *",
      timezone,
    },
  } as const;
}
