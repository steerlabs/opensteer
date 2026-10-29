import {
  createId,
  type AgentEvent,
  type RunId,
  type RunnerId,
  type WorkspaceId,
} from "@opensteer/core";
import type { OpensteerStore, SecurityEffectRecord, TriggerStore } from "@opensteer/database";
import type { RealtimeHub, RunnerRegistry } from "@opensteer/orchestration";
import { CorrelationIdSchema, type RunnerCommand } from "@opensteer/protocol";
import type { BrowserService } from "../browser/browser-service.js";
import type { WorkspaceMountService } from "../workspace/workspace-mount-service.js";

const claimLimit = 32;
const claimLeaseMilliseconds = 60_000;
const baseRetryMilliseconds = 1_000;
const maximumRetryMilliseconds = 5 * 60_000;

type SecurityEffectStore = Pick<
  OpensteerStore,
  | "claimSecurityEffects"
  | "completeSecurityEffect"
  | "failActiveRunsForMembershipRevocation"
  | "failActiveRunsForWorkspaceDeletion"
  | "failSecurityEffect"
>;

export class SecurityEffectService {
  readonly #browser: Pick<BrowserService, "revokeWorkspaceUser">;
  readonly #mounts: Pick<WorkspaceMountService, "revokeForMembership"> | undefined;
  readonly #onWatchDesiredChanged: (workspaceId: WorkspaceId) => Promise<void>;
  readonly #publish: (event: AgentEvent) => void;
  readonly #realtime: Pick<RealtimeHub, "closeUserWorkspace" | "publishViewerTasksChanged">;
  readonly #runners: Pick<RunnerRegistry, "dispatch" | "identityForEnvironment" | "revokeRuns">;
  readonly #store: SecurityEffectStore;
  readonly #triggers: Pick<
    TriggerStore,
    "activeExecutionsForMembershipRevocation" | "revokeForMembershipRevocation"
  >;
  #active: Promise<void> | undefined;

  constructor(options: {
    readonly browser: Pick<BrowserService, "revokeWorkspaceUser">;
    readonly mounts?: Pick<WorkspaceMountService, "revokeForMembership">;
    readonly onWatchDesiredChanged: (workspaceId: WorkspaceId) => Promise<void>;
    readonly publish: (event: AgentEvent) => void;
    readonly realtime: Pick<RealtimeHub, "closeUserWorkspace" | "publishViewerTasksChanged">;
    readonly runners: Pick<RunnerRegistry, "dispatch" | "identityForEnvironment" | "revokeRuns">;
    readonly store: SecurityEffectStore;
    readonly triggers: Pick<
      TriggerStore,
      "activeExecutionsForMembershipRevocation" | "revokeForMembershipRevocation"
    >;
  }) {
    this.#browser = options.browser;
    this.#mounts = options.mounts;
    this.#onWatchDesiredChanged = options.onWatchDesiredChanged;
    this.#publish = options.publish;
    this.#realtime = options.realtime;
    this.#runners = options.runners;
    this.#store = options.store;
    this.#triggers = options.triggers;
  }

  reconcile(): Promise<void> {
    this.#active ??= this.#drain().finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  async close(): Promise<void> {
    await this.#active?.catch(() => undefined);
  }

  async terminateWorkspace(workspaceId: SecurityEffectRecord["workspaceId"]): Promise<void> {
    await this.#applyRunRecovery(await this.#store.failActiveRunsForWorkspaceDeletion(workspaceId));
  }

  async #drain(): Promise<void> {
    for (;;) {
      const now = new Date();
      const effects = await this.#store.claimSecurityEffects({
        leaseUntil: new Date(now.getTime() + claimLeaseMilliseconds),
        limit: claimLimit,
        now,
      });
      if (effects.length === 0) return;
      await Promise.all(effects.map((effect) => this.#execute(effect)));
      if (effects.length < claimLimit) return;
    }
  }

  async #execute(effect: SecurityEffectRecord): Promise<void> {
    try {
      switch (effect.kind) {
        case "close-realtime":
          this.#realtime.publishViewerTasksChanged(effect.userId);
          this.#realtime.closeUserWorkspace(effect.userId, effect.workspaceId);
          break;
        case "stop-runs": {
          await this.#terminateAffectedRuns(effect);
          break;
        }
        case "revoke-browser":
          await this.#browser.revokeWorkspaceUser(effect.userId, effect.workspaceId);
          break;
        case "revoke-mounts":
          // Effects are independently retryable and may be claimed by a later
          // Host process. Make this effect self-sufficient instead of relying
          // on stop-runs having won an ordering race first.
          await this.#terminateAffectedRuns(effect);
          await this.#mounts?.revokeForMembership(effect.workspaceId, effect.userId);
          break;
        case "revoke-credentials":
          // Credential capabilities are Run-bound. Publishing the durable
          // terminal event revokes those exact in-memory broker handles.
          await this.#terminateAffectedRuns(effect);
          break;
        case "revoke-triggers":
          await this.#interruptAffectedTriggers(effect);
          await this.#triggers.revokeForMembershipRevocation({
            membershipGeneration: effect.membershipGeneration,
            userId: effect.userId,
            workspaceId: effect.workspaceId,
          });
          await this.#onWatchDesiredChanged(effect.workspaceId);
          break;
      }
      await this.#store.completeSecurityEffect(effect.id);
    } catch (error) {
      await this.#store.failSecurityEffect({
        effectId: effect.id,
        error: "security-effect-failed",
        nextAttemptAt: new Date(Date.now() + retryDelay(effect.attempts)),
      });
      throw error;
    }
  }

  async #terminateAffectedRuns(effect: SecurityEffectRecord): Promise<void> {
    const recovery = await this.#store.failActiveRunsForMembershipRevocation({
      userId: effect.userId,
      workspaceId: effect.workspaceId,
    });
    await this.#applyRunRecovery(recovery);
  }

  async #applyRunRecovery(
    recovery: Awaited<ReturnType<SecurityEffectStore["failActiveRunsForMembershipRevocation"]>>,
  ): Promise<void> {
    for (const event of recovery.events) this.#publish(event);
    // The Runs are already over on the Host, so a connected Runner is told to
    // stop them and report nothing more. One out of reach learns the same when
    // it reattaches, and its lease stops them meanwhile.
    const byRunner = new Map<RunnerId, { reason: string; runId: RunId }[]>();
    for (const target of recovery.terminatedRuns) {
      const runner = this.#runners.identityForEnvironment(target.environmentId);
      if (!runner) continue;
      const revocations = byRunner.get(runner.runnerId) ?? [];
      revocations.push({ reason: "Workspace access was revoked", runId: target.runId });
      byRunner.set(runner.runnerId, revocations);
    }
    await Promise.all(
      [...byRunner].map(([runnerId, revocations]) =>
        this.#runners.revokeRuns(runnerId, revocations),
      ),
    );
  }

  async #interruptAffectedTriggers(effect: SecurityEffectRecord): Promise<void> {
    const active = await this.#triggers.activeExecutionsForMembershipRevocation({
      membershipGeneration: effect.membershipGeneration,
      userId: effect.userId,
      workspaceId: effect.workspaceId,
    });
    await Promise.all(
      active.map(async ({ environmentId, occurrenceId }) => {
        const commandId = createId("command");
        const command: RunnerCommand = {
          commandId,
          correlationId: CorrelationIdSchema.parse(commandId),
          environmentId,
          occurrenceId,
          type: "trigger.interrupt",
        };
        await this.#runners.dispatch(command, AbortSignal.timeout(claimLeaseMilliseconds));
      }),
    );
  }
}

function retryDelay(attempt: number): number {
  return Math.min(
    baseRetryMilliseconds * 2 ** Math.min(Math.max(0, attempt - 1), 12),
    maximumRetryMilliseconds,
  );
}
