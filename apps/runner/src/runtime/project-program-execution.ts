import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type {
  ProjectExecuteTrigger,
  ProjectReconcileWatches,
  ProjectWatchBinding,
  ProjectTriggerBinding,
} from "@opensteer/protocol";
import type { TriggerProgramExecutor, ProgramLaunchPlanner } from "../agent/program-executor.js";
import { startProgramEndpoints } from "../agent/program-endpoints.js";
import { WatchSupervisor } from "../triggers/watch-supervisor.js";
import type { WorkspaceAccessManager } from "../workspace/mount-manager.js";
import type { ProjectExecution, ProjectExecutionEntry } from "./project-execution.js";
import type { RunnerMessageSink } from "./runtime.js";

interface Options {
  privateDirectory: string;
  nodeExecutable: string;
  workspaceManager: WorkspaceAccessManager;
  executor: Pick<TriggerProgramExecutor, "execute">;
  planLaunch: (
    id: string,
    launch: Parameters<ProgramLaunchPlanner>[0],
  ) => ReturnType<ProgramLaunchPlanner>;
  terminate: (id: string) => Promise<void>;
  mode: "development" | "production";
}

export class ProjectProgramExecution {
  readonly #options: Options;
  #watch?: WatchSupervisor;
  #generation = 0;
  readonly #watches = new Map<string, ProjectExecutionEntry>();
  constructor(options: Options) {
    this.#options = options;
  }
  async dispatch(
    command: ProjectExecuteTrigger | ProjectReconcileWatches,
    runtime: ProjectExecution,
  ) {
    if (command.type === "watch.reconcile.project") return this.#reconcile(command, runtime);
    if (
      command.context.event.source.kind !== "schedule" &&
      command.context.event.source.kind !== "watch"
    )
      throw new Error("Project Trigger source is unavailable");
    const context = command.context;
    const binding: ProjectTriggerBinding = {
      kind: "trigger",
      authority: context.authority,
      environmentId: command.environmentId,
      runnerId: runtime.identity().runnerId,
      runnerBootId: context.runnerBootId,
      workspaceId: context.workspaceId,
      anchorThreadId: context.anchorThreadId,
      triggerId: context.triggerId,
      revisionId: context.revisionId,
      executionGeneration: context.executionGeneration,
      occurrenceId: context.occurrenceId,
    };
    const entry = runtime.admit(binding, context.executionLeaseMs);
    entry.credentials.mcp = context.mcp.token;
    entry.task = this.#execute(command, runtime, entry, binding).catch(() => runtime.revoke(entry));
    return { status: "accepted" } as const;
  }
  async #execute(
    command: ProjectExecuteTrigger,
    runtime: ProjectExecution,
    entry: ProjectExecutionEntry,
    binding: ProjectTriggerBinding,
  ) {
    let endpoints: Awaited<ReturnType<typeof startProgramEndpoints>> | undefined;
    const stop = () => {
      endpoints?.revoke();
      void this.#options.terminate(binding.occurrenceId);
    };
    entry.abort.signal.addEventListener("abort", stop, { once: true });
    try {
      const workspace = await this.#options.workspaceManager.prepare({
        instructionsPath: null,
        plan: command.context.workspaceAccess,
        signal: entry.abort.signal,
      });
      endpoints = await startProgramEndpoints({
        capabilities: () => {
          if (entry.abort.signal.aborted || entry.deadline <= runtime.now())
            throw new Error("Project program lease ended");
          return {
            browserCdp: null,
            mcp: { ...command.context.mcp, token: entry.credentials.mcp! },
          };
        },
        transport: { mode: this.#options.mode },
      });
      entry.abort.signal.throwIfAborted();
      const output = await this.#options.executor.execute({
        context: command.context,
        workspace,
        signal: entry.abort.signal,
        endpoints: endpoints.endpoints,
        planLaunch: (launch) => this.#options.planLaunch(binding.occurrenceId, launch),
      });
      await runtime.emit(entry, {
        type: "runner.project.trigger-result",
        binding,
        ordinal: entry.ordinal,
        emittedAt: new Date().toISOString(),
        output,
      });
    } catch {
      await runtime.emit(entry, {
        type: "runner.project.trigger-result",
        binding,
        ordinal: entry.ordinal,
        emittedAt: new Date().toISOString(),
        output: {
          occurrenceId: binding.occurrenceId,
          completedAt: new Date().toISOString(),
          error: "Project Trigger failed",
          exitCode: null,
          result: null,
          status: "failed",
          stderr: "",
          stdout: "",
        },
      });
    } finally {
      entry.terminal = true;
      entry.abort.signal.removeEventListener("abort", stop);
      await endpoints?.close();
      await this.#options.terminate(binding.occurrenceId);
    }
  }
  async #reconcile(command: ProjectReconcileWatches, runtime: ProjectExecution) {
    if (command.reconcileGeneration <= this.#generation) return { status: "accepted" } as const;
    this.#watch ??= new WatchSupervisor({
      environmentId: command.environmentId,
      nodeExecutable: this.#options.nodeExecutable,
      privateStateDirectory: this.#options.privateDirectory,
      workspaceManager: this.#options.workspaceManager,
      planLaunch: (id, launch) => this.#options.planLaunch(id, launch),
      terminate: (id) => this.#options.terminate(id),
      transport: { mode: this.#options.mode },
    });
    const desired = new Set(command.desired.map((item) => item.activationId));
    for (const [id, entry] of this.#watches)
      if (!desired.has(id as ProjectWatchBinding["activationId"])) {
        runtime.revoke(entry);
        this.#watches.delete(id);
      }
    for (const item of command.desired) {
      const binding: ProjectWatchBinding = {
        kind: "watch",
        authority: item.authority,
        environmentId: command.environmentId,
        runnerId: runtime.identity().runnerId,
        runnerBootId: item.runnerBootId,
        workspaceId: item.workspaceId,
        anchorThreadId: item.anchorThreadId,
        triggerId: item.triggerId,
        revisionId: item.revisionId,
        executionGeneration: item.executionGeneration,
        activationId: item.activationId,
      };
      let entry = this.#watches.get(item.activationId);
      if (entry && canonicalJson(entry.binding) !== canonicalJson(binding)) {
        runtime.revoke(entry);
        entry = undefined;
      }
      if (!entry || entry.revoked) {
        entry = runtime.admit(binding, item.executionLeaseMs);
        this.#watches.set(item.activationId, entry);
      }
      entry.credentials.mcp = item.capabilities.mcp.token;
    }
    const sink: RunnerMessageSink = {
      send: async (message) => {
        if (message.type !== "runner.watch-status")
          throw new Error("Unexpected Project Watch report");
        const entry = this.#watches.get(message.activationId);
        if (!entry || entry.binding.kind !== "watch") return;
        const {
          activationId: _activation,
          executionGeneration: _generation,
          type: _type,
          ...status
        } = message;
        await runtime.emit(entry, {
          ...status,
          type: "runner.project.watch-status",
          binding: entry.binding,
          ordinal: entry.ordinal,
          emittedAt: new Date().toISOString(),
        });
      },
    };
    await this.#watch.reconcile(command, sink);
    for (const item of command.desired) {
      const entry = this.#watches.get(item.activationId)!;
      entry.stop = () => this.#watch!.stopProjectActivation(item.activationId, item);
      entry.renewed = (remainingMs) =>
        this.#watch!.renewProjectActivation(
          item.activationId,
          item.executionGeneration,
          remainingMs,
        );
      entry.credentialsChanged = () =>
        this.#watch!.renewProjectActivation(
          item.activationId,
          item.executionGeneration,
          Math.max(0, entry.deadline - runtime.now()),
          entry.credentials.mcp,
        );
    }
    this.#generation = command.reconcileGeneration;
    return { status: "accepted" } as const;
  }
  async close() {
    await this.#watch?.close();
  }
}
