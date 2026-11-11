import {
  OpensteerError,
  type AgentEvent,
  type LiveRunProgress,
  type ProjectRunBinding,
  type RunId,
} from "@opensteer/core";
import {
  AttachmentStore,
  assertActiveProjectBinding,
  plannedManagerlessProjects,
  ProjectControlDeliveryStore,
  ProjectExecutionStore,
  ProjectRequestStore,
  ProjectNotificationStore,
  projectRequestRevocationHooks,
  ProjectRunEventAcceptanceStore,
  ProjectRunRecoveryStore,
  ProjectWorkRevocationStore,
  ProjectWorkStopStore,
  ProjectWorkStore,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Clock } from "@opensteer/shared/clock";
import type { Kysely } from "kysely";
import { agentToolsPlanForProject } from "../agents/agent-tools-plan.js";
import { ProjectAttachmentReader } from "../agents/project-attachments.js";
import {
  ProjectCommandDispatcher,
  ProjectRunnerFrameService,
  projectPeerIsCurrentAndCapable,
  type ProjectRunnerTransport,
} from "../agents/project-dispatcher.js";
import { ProjectCapabilityTokenService } from "../agents/run-capability.js";
import type { SignedTokenService } from "../identity/host-keys.js";
import { ProjectCallerResolver } from "../mcp/agent-caller.js";
import { ProjectProductToolHandlers } from "../mcp/handlers/product.js";
import type { WorkspaceExecutionAccessService } from "../workspace/workspace-execution-access-service.js";
import { WorkspaceReconcileLoop } from "../workspace/workspace-reconcile-loop.js";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import { ProjectEgressService } from "../server/egress-service.js";
import { ProjectThreadNaming } from "../agents/thread-naming.js";
import type { ProjectRuntimePorts } from "./project-runtime-ports.js";

export interface ProjectRuntimeInfrastructure {
  readonly transport: ProjectRunnerTransport;
  readonly tokens: SignedTokenService;
  readonly workspaceAccess: Pick<WorkspaceExecutionAccessService, "planProject">;
  readonly dataDirectory: string;
  readonly agentToolsUrl: string;
  readonly egress: ProjectCommandDispatcher["options"]["egress"];
  readonly dispatcherId: string;
  readonly executionLeaseMs: number;
  readonly publish: (events: readonly AgentEvent[]) => void;
  readonly live: (binding: ProjectRunBinding, progress: LiveRunProgress) => void;
  /** Collect transaction-local events; the access service publishes only after commit. */
  readonly collectAccessEvents: ProjectWorkStopStore["collectEvents"];
  readonly onQueueWake: (wake: () => void) => () => void;
  readonly onRunnerWake: (wake: () => void) => () => void;
  readonly onError: (error: unknown) => void;
  readonly clock?: Pick<Clock, "schedule">;
}

/** Constructed only by the stored-authority factory; startup policy remains independently fenced. */
export class ProjectRuntime implements ProjectRuntimePorts {
  readonly admission: ProjectWorkStore;
  readonly capabilities: ProjectCapabilityTokenService;
  readonly dispatch: ProjectCommandDispatcher;
  readonly recovery: ProjectRunRecoveryStore;
  readonly requests: ProjectRequestStore;
  readonly notifications: ProjectNotificationStore;
  readonly controls: ProjectControlDeliveryStore;
  readonly revocation: ProjectWorkRevocationStore;
  readonly frames: ProjectRunnerFrameService;
  readonly callers: ProjectCallerResolver;
  readonly tools: ProjectProductToolHandlers;
  readonly attachments: ProjectAttachmentReader;
  readonly mcp: OpensteerMcpService;
  readonly egress: ProjectEgressService;
  readonly naming: ProjectThreadNaming;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #infrastructure: ProjectRuntimeInfrastructure;
  readonly #loop: WorkspaceReconcileLoop;
  #detach: (() => void)[] = [];
  #active: Promise<void> | undefined;
  #closed = false;

  constructor(database: Kysely<DatabaseSchema>, infrastructure: ProjectRuntimeInfrastructure) {
    this.#database = database;
    this.#infrastructure = infrastructure;
    const { transport, publish } = infrastructure;
    const peerIsCurrent = (peer: Parameters<typeof projectPeerIsCurrentAndCapable>[1]) =>
      projectPeerIsCurrentAndCapable(transport, peer);
    const attached = (runnerId: ProjectRunBinding["runnerId"], bootId: string) => {
      const peer = transport.identityForRunner(runnerId);
      return Boolean(peer && peer.bootId === bootId && peerIsCurrent(peer.fence));
    };
    this.requests = new ProjectRequestStore(database, new ProjectExecutionStore());
    this.notifications = new ProjectNotificationStore(database);
    const cancelRunRequests = this.requests.cancelRun.bind(this.requests);
    this.admission = new ProjectWorkStore(database, {
      runnerIsConnected: (id) => {
        const identity = transport.identityForRunner(id);
        return Boolean(identity && peerIsCurrent(identity.fence));
      },
      runnerIsAttached: attached,
      cancelRunRequests,
    });
    this.capabilities = new ProjectCapabilityTokenService({
      tokens: infrastructure.tokens,
      authorizer: {
        assertProjectBinding: (binding) =>
          assertActiveProjectBinding(database, binding, { runnerIsAttached: attached }).then(
            () => undefined,
          ),
      },
    });
    this.controls = new ProjectControlDeliveryStore(database, {
      currentPeerIsProjectCapable: peerIsCurrent,
      currentRunnerBootId: (id) => transport.identityForRunner(id)?.bootId ?? null,
      canContinue: this.requests.canContinue.bind(this.requests),
      cancelRunRequests,
    });
    const work = new ProjectWorkStopStore(infrastructure.collectAccessEvents);
    this.revocation = new ProjectWorkRevocationStore({
      requests: projectRequestRevocationHooks(this.requests, work),
      work,
      plannedManagerless: plannedManagerlessProjects,
      managerlessRequests: {
        discover: this.requests.discoverManagerless.bind(this.requests),
        cancelPlanned: async (tx, workspaceIds) => {
          await this.requests.cancelPlannedManagerless(tx, workspaceIds, work);
        },
      },
    });
    this.recovery = new ProjectRunRecoveryStore(database, {
      currentRunner: (environmentId) => {
        const identity = transport.current(environmentId);
        return identity && peerIsCurrent(identity.fence)
          ? { runnerId: identity.runnerId, runnerBootId: identity.bootId }
          : null;
      },
      cancelRequests: cancelRunRequests,
      publish,
    });
    this.dispatch = new ProjectCommandDispatcher({
      ...infrastructure,
      database,
      capabilities: this.capabilities,
      controls: this.controls,
      agentToolsPlan: (input) =>
        agentToolsPlanForProject({ ...input, url: infrastructure.agentToolsUrl }),
    });
    const events = new ProjectRunEventAcceptanceStore(database, {
      currentPeerIsProjectCapable: peerIsCurrent,
      requests: this.requests,
      cancelRunRequests,
      cancelRequest: this.requests.cancelEngineRequest.bind(this.requests),
      links: {
        threadUrl: (threadId) =>
          new URL(`/threads/${threadId}`, infrastructure.agentToolsUrl).toString(),
      },
    });
    this.frames = new ProjectRunnerFrameService({
      ...infrastructure,
      database,
      capabilities: this.capabilities,
      controls: this.controls,
      events,
    });
    this.callers = new ProjectCallerResolver({
      capabilities: this.capabilities,
      resolve: this.admission.resolveProjectCaller.bind(this.admission),
    });
    this.tools = new ProjectProductToolHandlers({
      work: this.admission,
      publish,
      environmentConnected: (id) => {
        const peer = transport.current(id);
        return Boolean(peer && peerIsCurrent(peer.fence));
      },
    });
    this.attachments = new ProjectAttachmentReader({
      dataDirectory: infrastructure.dataDirectory,
      store: new AttachmentStore(database),
      capabilities: this.capabilities,
    });
    const publicUrl = new URL(infrastructure.agentToolsUrl);
    this.mcp = new OpensteerMcpService({
      callers: this.callers,
      projectTools: this.tools,
      publicUrl,
      onToolError: infrastructure.onError,
    });
    this.egress = new ProjectEgressService({ capabilities: this.capabilities, publicUrl });
    this.naming = new ProjectThreadNaming({
      work: this.admission,
      publish,
      onError: infrastructure.onError,
    });
    this.#loop = new WorkspaceReconcileLoop({
      ...(infrastructure.clock ? { clock: infrastructure.clock } : {}),
      intervalMs: Math.min(10_000, Math.floor(infrastructure.executionLeaseMs / 4)),
      sweep: () => undefined,
      onError: infrastructure.onError,
      reconcile: () => this.reconcile(),
    });
  }

  async start(): Promise<void> {
    try {
      const wake = () => {
        void this.reconcile().catch(this.#infrastructure.onError);
      };
      this.#detach.push(this.#infrastructure.onQueueWake(wake));
      this.#detach.push(this.#infrastructure.onRunnerWake(wake));
      await this.reconcile();
      this.#loop.start();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  reconcile(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#active) return this.#active;
    const active = this.#reconcile().finally(() => {
      if (this.#active === active) this.#active = undefined;
    });
    this.#active = active;
    return active;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const detach of this.#detach.splice(0)) detach();
    const results = await Promise.allSettled([
      this.#loop.close(),
      this.naming.stop(),
      this.mcp.close(),
      this.#active,
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Project runtime shutdown failed");
  }

  async #reconcile(): Promise<void> {
    let after: RunId | undefined;
    for (;;) {
      const runs = await this.#database
        .selectFrom("runs")
        .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
        .select(["runs.id", "runs.bindingGeneration"])
        .where("principals.kind", "=", "project")
        .where("runs.status", "in", ["starting", "running", "waiting"])
        .$call((query) => (after ? query.where("runs.id", ">", after) : query))
        .orderBy("runs.id")
        .limit(100)
        .execute();
      for (const run of runs)
        await this.recovery.recover({
          runId: run.id,
          expectedBindingGeneration: run.bindingGeneration,
        });
      if (runs.length < 100 || this.#closed) break;
      after = runs.at(-1)?.id;
    }
    if (this.#closed) return;
    const results = await this.#database
      .selectFrom("delegations")
      .innerJoin("runs", "runs.id", "delegations.childRunId")
      .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
      .select("delegations.id")
      .where("principals.kind", "=", "project")
      .where("delegations.status", "!=", "open")
      .where("delegations.resultStatus", "=", "pending")
      .orderBy("delegations.id")
      .limit(100)
      .execute();
    for (const result of results) {
      const delivered = await this.admission.deliverAssignmentResult(result.id);
      this.#infrastructure.publish(delivered.events);
    }
    const pending = await this.#database
      .selectFrom("threadInputs")
      .innerJoin("principals", "principals.id", "threadInputs.actorPrincipalId")
      .select("threadInputs.threadId")
      .distinct()
      .where("principals.kind", "=", "project")
      .where("threadInputs.state", "=", "pending")
      .where("threadInputs.runId", "is", null)
      .orderBy("threadInputs.threadId")
      .limit(100)
      .execute();
    for (const item of pending) {
      const admitted = await this.admission.recoverPendingProjectWork(item.threadId);
      this.#infrastructure.publish(admitted.events);
    }
    await this.naming.reconcile();
    for (const outcome of await this.dispatch.drainPending())
      if (outcome.state === "unavailable")
        this.#infrastructure.onError(
          new OpensteerError({
            code: "conflict",
            reason: outcome.reason ?? "project-command-unavailable",
            message: "Project command is unavailable",
          }),
        );
  }
}
