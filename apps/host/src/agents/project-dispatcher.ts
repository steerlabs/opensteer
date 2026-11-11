import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CommandIdSchema,
  OpensteerError,
  ProjectRunBindingSchema,
  SequenceSchema,
  type AgentEvent,
  type CommandId,
  type EnvironmentId,
  type ProjectRunBinding,
  type ThreadAccessMode,
  type ThreadRole,
  type RunnerId,
  type LiveRunProgress,
} from "@opensteer/core";
import {
  assertActiveProjectBinding,
  assertProjectAuthority,
  loadProjectRunDispatchContext,
  ProjectBindingStore,
  ProjectControlDeliveryStore,
  ProjectRunEventAcceptanceStore,
  ProjectRuntimeSnapshotSchema,
  readProjectRunThreadState,
  readProjectRunBinding,
  StoredProjectControlSchema,
  type DatabaseSchema,
} from "@opensteer/database";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  CorrelationIdSchema,
  HarnessInputSchema,
  ProjectExecutableCommandSchema,
  ProjectExecuteRunSchema,
  ProjectHostToRunnerMessageSchema,
  RunnerConnectionFenceSchema,
  ProjectRunnerToHostMessageSchema,
  sameRunnerConnectionFence,
  executionLeaseMsSchema,
  type ProjectExecutableCommand,
  type ProjectHostToRunnerMessage,
  type ProjectRunControl,
  type RunAgentToolsPlan,
  type RunnerConnectionFence,
} from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { ProjectDispatchPort } from "../runtime/project-runtime-ports.js";
import type { WorkspaceExecutionAccessService } from "../workspace/workspace-execution-access-service.js";
import type { ProjectCapabilityTokenService } from "./run-capability.js";

/** Adapt the authenticated registry; this port neither registers nor selects another Runner. */
export interface ProjectRunnerTransport {
  current(environmentId: EnvironmentId): RunnerIdentity | null;
  identityForRunner(runnerId: RunnerId): RunnerIdentity | undefined;
  isCurrent(peer: RunnerConnectionFence): boolean;
  sendCommand(peer: RunnerConnectionFence, command: ProjectExecutableCommand): Promise<void>;
  sendFrame(peer: RunnerConnectionFence, frame: ProjectHostToRunnerMessage): Promise<void>;
}

export function projectPeerIsCurrentAndCapable(
  transport: ProjectRunnerTransport,
  peer: RunnerConnectionFence,
): boolean {
  const identity = transport.identityForRunner(peer.runnerId);
  return Boolean(
    identity &&
    identity.runnerId === peer.runnerId &&
    identity.bootId === peer.bootId &&
    identity.capabilities.includes("project-authority-v1") &&
    sameRunnerConnectionFence(identity.fence, peer) &&
    transport.isCurrent(peer),
  );
}

export class ProjectCommandDispatcher implements ProjectDispatchPort {
  readonly options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly transport: ProjectRunnerTransport;
    readonly capabilities: ProjectCapabilityTokenService;
    readonly workspaceAccess: Pick<WorkspaceExecutionAccessService, "planProject">;
    readonly controls: ProjectControlDeliveryStore;
    readonly executionLeaseMs: number;
    readonly dispatcherId: string;
    readonly agentToolsPlan: (input: {
      readonly binding: ProjectRunBinding;
      readonly token: string;
      readonly role: ThreadRole;
      readonly accessMode: ThreadAccessMode;
    }) => RunAgentToolsPlan;
    readonly egress: {
      readonly relayUrl: string;
      readonly maxRequestBytes: number;
      readonly maxResponseBytes: number;
    };
    readonly publish: (events: readonly AgentEvent[]) => void;
  };

  constructor(options: ProjectCommandDispatcher["options"]) {
    executionLeaseMsSchema.parse(options.executionLeaseMs);
    this.options = options;
  }

  #peer(environmentId: EnvironmentId, binding?: ProjectRunBinding): RunnerIdentity {
    const identity = this.options.transport.current(environmentId);
    if (
      !identity ||
      !identity.environmentIds.includes(environmentId) ||
      !identity.capabilities.includes("project-authority-v1") ||
      !this.options.transport.isCurrent(identity.fence) ||
      (binding &&
        (identity.runnerId !== binding.runnerId || identity.bootId !== binding.runnerBootId))
    )
      throw new OpensteerError({
        code: "conflict",
        reason: "project-runner-unavailable",
        message: "Project work requires its authenticated, attached Project-capable Runner",
      });
    RunnerConnectionFenceSchema.parse(identity.fence);
    return identity;
  }

  async dispatchQueued(commandId: CommandId): Promise<ProjectRunBinding> {
    CommandIdSchema.parse(commandId);
    await assertProjectAuthority(this.options.database);
    const selected = await this.options.database
      .selectFrom("commands")
      .select("environmentId")
      .where("id", "=", commandId)
      .where("type", "=", "run.execute.project")
      .executeTakeFirst();
    if (!selected?.environmentId)
      throw new OpensteerError({ code: "not_found", message: "Project command is unavailable" });
    const identity = this.#peer(selected.environmentId);
    const bound = await new ProjectBindingStore(this.options.database, {
      runnerIsAttached: (id, boot) =>
        id === identity.runnerId &&
        boot === identity.bootId &&
        this.options.transport.isCurrent(identity.fence),
    }).acquire({
      commandId,
      dispatcherId: this.options.dispatcherId,
      runnerId: identity.runnerId,
      runnerBootId: identity.bootId,
      leaseExpiresAt: new Date(Date.now() + this.options.executionLeaseMs),
      leaseTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    });
    this.options.publish(bound.events);
    const context = await loadProjectRunDispatchContext(
      this.options.database,
      commandId,
      bound.binding,
      (id, boot) =>
        id === identity.runnerId &&
        boot === identity.bootId &&
        this.options.transport.isCurrent(identity.fence),
    );
    const harness = await this.options.database
      .selectFrom("harnessInstances")
      .selectAll()
      .where("id", "=", bound.snapshot.harnessInstanceId)
      .executeTakeFirstOrThrow();
    const assignment = context.run.assignmentId
      ? await this.options.database
          .selectFrom("delegations")
          .selectAll()
          .where("id", "=", context.run.assignmentId)
          .executeTakeFirstOrThrow()
      : null;
    const workspaceAccess = await this.options.workspaceAccess.planProject({
      binding: bound.binding,
      runnerIdentity: identity,
      workspace: context.workspace,
    });
    const [toolsToken, attachmentToken, egressToken, threadState] = await Promise.all([
      this.options.capabilities.issue(bound.binding, "opensteer-project-run-tools"),
      this.options.capabilities.issue(bound.binding, "opensteer-project-run-attachments"),
      this.options.capabilities.issue(bound.binding, "opensteer-project-egress"),
      readProjectRunThreadState(
        this.options.database,
        bound.binding,
        (id, boot) =>
          id === identity.runnerId &&
          boot === identity.bootId &&
          this.options.transport.isCurrent(identity.fence),
      ),
    ]);
    const tools = this.options.agentToolsPlan({
      binding: bound.binding,
      token: toolsToken,
      role: context.thread.role,
      accessMode: bound.snapshot.accessMode,
    });
    const input = (message: (typeof context.inputs)[number]) =>
      HarnessInputSchema.parse({
        author: message.author,
        content: message.content,
        createdAt: message.createdAt,
        kind: message.kind,
        messageId: message.id,
        ...(message.quote ? { quote: message.quote } : {}),
      });
    const command = ProjectExecuteRunSchema.parse({
      commandId,
      correlationId: CorrelationIdSchema.parse(commandId),
      environmentId: bound.binding.environmentId,
      type: "run.execute.project",
      inputs: context.inputs.map(input),
      reports: {
        messages: context.reports.messages.map(input),
        omittedCount: context.reports.omittedCount,
        throughSequence:
          context.reports.throughSequence === null
            ? null
            : SequenceSchema.parse(context.reports.throughSequence),
      },
      context: {
        authority: bound.binding.authority,
        grantId: bound.binding.grantId,
        runnerBootId: bound.binding.runnerBootId,
        bindingGeneration: bound.binding.bindingGeneration,
        runId: bound.binding.runId,
        threadId: bound.binding.threadId,
        workspaceId: bound.binding.workspaceId,
        workspaceKind: "project",
        environmentId: bound.binding.environmentId,
        projectSettingsRevision: bound.snapshot.settingsRevision,
        projectTimeZone: bound.snapshot.timeZone,
        accessMode: bound.snapshot.accessMode,
        modelSelection: bound.snapshot.modelSelection,
        agentTools: {
          ...tools,
          instructions: [tools.instructions, bound.snapshot.instructions]
            .filter(Boolean)
            .join("\n\n"),
        },
        attachments: { token: attachmentToken },
        egress: { ...this.options.egress, relayToken: egressToken },
        threadRole: context.thread.role,
        threadState,
        assignment: assignment
          ? {
              id: assignment.id,
              objective: assignment.objective,
              origin: assignment.origin,
              parentThreadId: assignment.parentThreadId,
            }
          : null,
        executionLeaseMs: this.options.executionLeaseMs,
        credentialRefreshAfterMs: this.options.capabilities.lifetimeSeconds * 500,
        firstOrdinal: context.firstOrdinal,
        harness: {
          config: harness.config,
          driverKind: harness.driverKind,
          name: harness.name,
          runtimeRevision: harness.runtimeRevision,
          sourceId: harness.sourceId,
          stateKind: harness.stateKind,
        },
        harnessInstanceId: bound.snapshot.harnessInstanceId,
        providerSessionId: context.executionBinding?.providerSessionId,
        providerSessionStateLayout: context.providerSessionStateLayout,
        providerSessionReference: context.executionBinding?.providerSessionReference ?? null,
        history:
          context.executionBinding?.providerSessionReference && !context.initialContext
            ? context.history
            : [],
        historyWindow:
          context.executionBinding?.providerSessionReference && !context.initialContext
            ? context.historyWindow
            : { byteCount: 0, hasEarlier: false, itemCount: 0 },
        initialContext: context.initialContext
          ? {
              messages: context.initialContext.messages,
              omittedCount: context.initialContext.omittedCount,
              throughSequence: context.initialContext.throughSequence,
            }
          : null,
        workspaceAccess,
        workspaceInstructionsPath: "AGENTS.md",
      },
    });
    await this.dispatch(command);
    return bound.binding;
  }

  async dispatch(input: ProjectExecutableCommand): Promise<void> {
    const identity = this.#peer(input.environmentId);
    const command = ProjectExecutableCommandSchema.parse(input);
    if (command.type !== "run.execute.project")
      throw new OpensteerError({
        code: "conflict",
        reason: "project-program-routing-unavailable",
        message: "Project program routing belongs to the Trigger slice",
      });
    const binding = ProjectRunBindingSchema.parse({
      authority: command.context.authority,
      grantId: command.context.grantId,
      runnerBootId: command.context.runnerBootId,
      runnerId: identity.runnerId,
      bindingGeneration: command.context.bindingGeneration,
      environmentId: command.environmentId,
      runId: command.context.runId,
      threadId: command.context.threadId,
      workspaceId: command.context.workspaceId,
    });
    this.#peer(command.environmentId, binding);
    await assertActiveProjectBinding(this.options.database, binding, {
      runnerIsAttached: (id, boot) =>
        id === identity.runnerId &&
        boot === identity.bootId &&
        this.options.transport.isCurrent(identity.fence),
    });
    const stored = await this.options.database
      .selectFrom("runs")
      .select("authoritySource")
      .where("id", "=", binding.runId)
      .executeTakeFirstOrThrow();
    const snapshot = ProjectRuntimeSnapshotSchema.parse(stored.authoritySource.projectRuntime);
    if (
      !isDeepStrictEqual(snapshot.modelSelection, command.context.modelSelection) ||
      snapshot.accessMode !== command.context.accessMode ||
      snapshot.harnessInstanceId !== command.context.harnessInstanceId ||
      snapshot.timeZone !== command.context.projectTimeZone ||
      snapshot.settingsRevision !== command.context.projectSettingsRevision
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Project command changed its admitted runtime",
      });
    this.#peer(command.environmentId, binding);
    await this.options.transport.sendCommand(identity.fence, command);
  }

  async deliverControl(commandId: CommandId) {
    const delivery = await this.options.controls.claim(commandId, this.options.dispatcherId);
    if (delivery.state === "ready") await this.control(delivery);
    else this.options.publish(await this.options.controls.settleUnavailable(commandId));
    return delivery;
  }

  /** Called at startup and after queue/connection wakes; commands is the only durable outbox. */
  async drainPending(limit = 100) {
    const commands = await this.options.controls.pendingCommands(limit);
    const results: {
      commandId: CommandId;
      state:
        | "dispatched"
        | "ready"
        | "offline"
        | "settled"
        | "disposed"
        | "uncertain"
        | "absent"
        | "unavailable";
      reason?: string;
    }[] = [];
    for (const command of commands) {
      try {
        if (command.type === "run.execute.project") {
          await this.dispatchQueued(command.id);
          results.push({ commandId: command.id, state: "dispatched" });
        } else {
          const delivery = await this.deliverControl(command.id);
          results.push({ commandId: command.id, state: delivery.state });
        }
      } catch (error) {
        if (!(error instanceof OpensteerError)) throw error;
        results.push({
          commandId: command.id,
          state: "unavailable",
          reason: error.reason ?? error.code,
        });
      }
    }
    return results;
  }

  async control(input: {
    readonly binding: ProjectRunBinding;
    readonly commandId: CommandId;
    readonly correlationId: string;
    readonly control: ProjectRunControl;
  }): Promise<void> {
    const identity = this.#peer(input.binding.environmentId, input.binding);
    const frame = ProjectHostToRunnerMessageSchema.parse({
      ...identity.fence,
      type: "host.project.run-control",
      ...input,
    });
    const command = await this.options.database
      .selectFrom("commands")
      .select(["payload", "status", "type"])
      .where("id", "=", input.commandId)
      .executeTakeFirst();
    if (
      !command ||
      command.type !== "run.control.project" ||
      command.status !== "dispatched" ||
      !isDeepStrictEqual(StoredProjectControlSchema.parse(command.payload), {
        binding: input.binding,
        control: input.control,
        correlationId: input.correlationId,
      })
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Project control has no matching durable delivery",
      });
    const original = await readProjectRunBinding(this.options.database, {
      runId: input.binding.runId,
      grantId: input.binding.grantId,
    });
    if (!original || !isDeepStrictEqual(original.binding, input.binding))
      throw new OpensteerError({
        code: "forbidden",
        message: "Project control lost its original binding",
      });
    if (input.control.kind !== "run.interrupt" && input.control.kind !== "request.refuse")
      await this.options.capabilities.assertProjectBinding(input.binding);
    this.#peer(input.binding.environmentId, input.binding);
    await this.options.transport.sendFrame(identity.fence, frame);
  }
}

export class ProjectRunnerFrameService {
  readonly options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly transport: ProjectRunnerTransport;
    readonly capabilities: ProjectCapabilityTokenService;
    readonly controls: ProjectControlDeliveryStore;
    readonly events: ProjectRunEventAcceptanceStore;
    readonly executionLeaseMs: number;
    readonly publish: (events: readonly AgentEvent[]) => void;
    readonly live: (binding: ProjectRunBinding, progress: LiveRunProgress) => void;
  };
  constructor(options: ProjectRunnerFrameService["options"]) {
    executionLeaseMsSchema.parse(options.executionLeaseMs);
    this.options = options;
  }

  async handle(peerInput: RunnerConnectionFence, raw: unknown): Promise<void> {
    const peer = RunnerConnectionFenceSchema.parse(peerInput);
    const current = () => projectPeerIsCurrentAndCapable(this.options.transport, peer);
    if (!current())
      throw new OpensteerError({
        code: "forbidden",
        message: "Project frame peer is not authenticated and capable",
      });
    const frame = ProjectRunnerToHostMessageSchema.parse(raw);
    if (!sameRunnerConnectionFence(peer, frame))
      throw new OpensteerError({
        code: "forbidden",
        message: "Project frame does not match its authenticated connection",
      });
    await assertProjectAuthority(this.options.database);
    const send = async (message: unknown) => {
      const parsed = ProjectHostToRunnerMessageSchema.parse(message);
      if (!current())
        throw new OpensteerError({
          code: "forbidden",
          message: "Project connection changed before response delivery",
        });
      await this.options.transport.sendFrame(peer, parsed);
    };
    const bindings = new ProjectBindingStore(this.options.database, {
      runnerIsAttached: (id, boot) => id === peer.runnerId && boot === peer.bootId && current(),
    });
    switch (frame.type) {
      case "runner.project.event": {
        const accepted = await this.options.events.accept(peer, frame);
        this.options.publish(accepted.events);
        await send({
          ...peer,
          type: "host.project.events.acked",
          acks: [
            {
              binding: { ...accepted.binding, kind: "run" },
              throughOrdinal: accepted.ordinal,
              sessionBound: false,
            },
          ],
        });
        return;
      }
      case "runner.project.control-result": {
        const result = await this.options.controls.recordResult(peer, frame);
        if ("events" in result) this.options.publish(result.events);
        this.options.publish(await this.options.controls.settleUnavailable(frame.commandId));
        return;
      }
      case "runner.project.live":
        await this.options.capabilities.assertProjectBinding(frame.binding);
        if (!current())
          throw new OpensteerError({
            code: "forbidden",
            message: "Project connection changed before progress delivery",
          });
        this.options.live(frame.binding, frame.progress);
        return;
      case "runner.project.session-bound": {
        const accepted = await bindings.sessionBound(frame);
        await send({
          ...peer,
          type: "host.project.events.acked",
          acks: [
            {
              binding: { ...frame.binding, kind: "run" },
              throughOrdinal: accepted.nextOrdinal - 1,
              sessionBound: true,
            },
          ],
        });
        return;
      }
      case "runner.project.grants.refresh": {
        if (frame.binding.kind !== "run")
          throw new OpensteerError({
            code: "conflict",
            reason: "project-program-routing-unavailable",
            message: "Project program credentials belong to the Trigger slice",
          });
        const { kind: _kind, ...binding } = frame.binding;
        let result: Extract<
          ProjectHostToRunnerMessage,
          { type: "host.project.grants.credentials" }
        >["result"];
        try {
          const [agentTools, attachments, egress] = await Promise.all([
            this.options.capabilities.issue(binding, "opensteer-project-run-tools"),
            this.options.capabilities.issue(binding, "opensteer-project-run-attachments"),
            this.options.capabilities.issue(binding, "opensteer-project-egress"),
          ]);
          await this.options.capabilities.assertProjectBinding(binding);
          result = {
            status: "issued",
            credentials: { kind: "run", agentTools, attachments, egress },
          };
        } catch (error) {
          if (!(error instanceof OpensteerError)) throw error;
          result = { status: error.code === "forbidden" ? "refused" : "unavailable" };
        }
        await send({
          ...peer,
          type: "host.project.grants.credentials",
          requestId: frame.requestId,
          binding: frame.binding,
          result,
        });
        return;
      }
      case "runner.project.heartbeat": {
        const renewed = [];
        const revoked = [];
        for (const address of frame.bindings) {
          if (address.kind !== "run")
            throw new OpensteerError({
              code: "conflict",
              reason: "project-program-routing-unavailable",
              message: "Project program renewal belongs to the Trigger slice",
            });
          const { kind: _kind, ...binding } = address;
          try {
            await bindings.renew({
              binding,
              leaseExpiresAt: new Date(Date.now() + this.options.executionLeaseMs),
            });
            renewed.push(address);
          } catch (error) {
            if (!(error instanceof OpensteerError)) throw error;
            revoked.push({
              binding: address,
              reason: "The stored Project binding is no longer available",
            });
          }
        }
        await send({
          ...peer,
          type: "host.project.executions.renewed",
          heartbeatSentAt: frame.sentAt,
          leaseMs: this.options.executionLeaseMs,
          bindings: renewed,
        });
        if (revoked.length)
          await send({ ...peer, type: "host.project.executions.revoked", revocations: revoked });
        return;
      }
      case "runner.project.executions.attach": {
        const results = [];
        for (const execution of frame.executions) {
          if (execution.binding.kind !== "run")
            throw new OpensteerError({
              code: "conflict",
              reason: "project-program-routing-unavailable",
              message: "Project program attachment belongs to the Trigger slice",
            });
          const { kind: _kind, ...binding } = execution.binding;
          try {
            const accepted = await bindings.renew({
              binding,
              leaseExpiresAt: new Date(Date.now() + this.options.executionLeaseMs),
            });
            results.push({
              binding: execution.binding,
              status: "attached" as const,
              nextOrdinal: accepted.nextOrdinal,
            });
          } catch (error) {
            if (!(error instanceof OpensteerError)) throw error;
            results.push({
              binding: execution.binding,
              status: "revoked" as const,
              reason: "The stored Project binding is no longer available",
            });
          }
        }
        // Completeness never authorizes retiring a binding that this Project frame omitted.
        await send({
          ...peer,
          type: "host.project.executions.attached",
          leaseMs: this.options.executionLeaseMs,
          results,
        });
        return;
      }
      case "runner.project.trigger-result":
      case "runner.project.watch-status":
        throw new OpensteerError({
          code: "conflict",
          reason: "project-program-routing-unavailable",
          message: "Project program events belong to the Trigger slice",
        });
    }
  }
}
