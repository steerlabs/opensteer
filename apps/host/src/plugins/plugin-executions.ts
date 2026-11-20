import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentSessionIdSchema,
  agentGrantAccess,
  OpensteerError,
  type ThreadId,
  threadAccessModeAtMost,
  type RequestId,
  type RequestPresentation,
  type RequestResponse,
  type RunId,
  type UserId,
} from "@opensteer/core";
import {
  PluginAgentStore,
  type AgentOperationRow,
  type OpensteerStore,
  type PluginExecutionRecord,
} from "@opensteer/database";
import {
  commitPersonalMutation,
  type PersonalCommitReaction,
} from "@opensteer/database/personal-mutation";
import {
  callerLineage,
  type AgentCaller,
  type ConnectionCaller,
  type RunCaller,
} from "../mcp/agent-caller.js";
import { pluginCaller, type PluginAuthority } from "./plugin-authority.js";
import {
  pluginCallerSubject,
  type PluginCaller,
  type PluginExecution,
  PluginServiceError,
  operations,
} from "./engine-protocol.js";
import { OperationOutcomeUnknown } from "../agent-sessions/agent-session-service.js";
import type { EngineProcess } from "./engine-process.js";
import type { PluginService } from "./plugin-service.js";

export const pluginInterruptedReason =
  "Plugin program interrupted. Earlier calls may have taken effect. Check current state with a safe read; never rerun the program blindly.";
const terminal = new Set(["completed", "cancelled", "expired", "interrupted", "failed"]);
const interactionEnded = new Error("Plugin execution changed before attaching its Request");
const object = z.record(z.string(), z.json());
export class PluginExecutions {
  readonly #changes = new EventEmitter();
  readonly #drivers = new Set<string>();
  readonly #answers = new Set<string>();
  readonly #submissions = new Map<string, AbortController>();
  #reports: Promise<void> = Promise.resolve();
  readonly options: {
    service: PluginService;
    store: OpensteerStore;
    records: PluginAgentStore;
    authority: PluginAuthority;
    onError: (error: unknown) => void;
    localName?: (context: PluginCaller, plugin: string) => Promise<string | undefined>;
  };
  constructor(options: PluginExecutions["options"]) {
    this.options = options;
    this.#changes.setMaxListeners(0);
  }
  report(execution: PluginExecution) {
    this.options.authority.execution(execution.id, execution.caller, true);
    this.#reports = this.#reports
      .then(() => this.#record(execution))
      .catch(this.options.onError)
      .finally(() => {
        if (terminal.has(execution.state))
          this.options.authority.execution(execution.id, execution.caller, false);
      });
  }
  settled(): Promise<void> {
    return this.#reports;
  }
  async #record(execution: PluginExecution) {
    const row = await this.options.records.execution(execution.id);
    if (!row || row.caller !== execution.caller) return;
    if (row.connectionId && execution.drained && !row.terminalEvidenceAt) {
      await this.options.store.database
        .updateTable("pluginExecutions")
        .set({ terminalEvidenceAt: new Date(), contactLostAt: null })
        .where("id", "=", row.id)
        .where("terminalEvidenceAt", "is", null)
        .execute();
    }
    if (terminal.has(row.state)) return;
    const result =
      execution.state === "completed" && execution.result
        ? object.parse({
            data: execution.result,
            ...(execution.targets ? { targets: execution.targets } : {}),
          })
        : null;
    const updated = await this.options.records.updateLive(execution.id, {
      state: execution.state,
      result,
      reason: execution.reason ?? null,
    });
    if (!updated) return;
    if (
      ["interrupted", "expired", "cancelled", "failed"].includes(execution.state) &&
      updated.requestId
    ) {
      await this.options.store.requests.endPluginExecutionRequest(
        updated.requestId,
        execution.state === "expired"
          ? "plugin-expired"
          : execution.state === "interrupted"
            ? "plugin-interrupted"
            : "run-ended",
      );
    }
    this.#changes.emit(execution.id);
  }
  async recover() {
    await this.#reports;
    await this.options.store.database
      .updateTable("pluginExecutions")
      .set({ contactLostAt: new Date() })
      .where("connectionId", "is not", null)
      .where("terminalEvidenceAt", "is", null)
      .where("contactLostAt", "is", null)
      .execute();
    for (const row of await this.options.records.unfinished()) {
      if (this.#submissions.has(row.id)) continue;
      const updated = await this.options.records.updateLive(row.id, {
        state: "interrupted",
        reason: pluginInterruptedReason,
        result: null,
      });
      if (updated?.requestId) {
        await this.options.store.requests.endPluginExecutionRequest(
          updated.requestId,
          "plugin-interrupted",
        );
      }
      this.#changes.emit(row.id);
    }
  }
  async execute(
    caller: AgentCaller,
    operation: "call" | "execute",
    input: unknown,
    signal?: AbortSignal,
  ) {
    const context = this.options.authority.admit(caller);
    await this.options.authority.assert(context, operation);
    const id = randomUUID();
    const args = z
      .object({ calls: z.unknown().optional(), code: z.unknown().optional() })
      .parse(input);
    const call =
      operation === "call"
        ? operations.call.input.parse({ calls: args.calls, executionId: id })
        : undefined;
    const program =
      operation === "execute"
        ? operations.execute.input.parse({ code: args.code, executionId: id })
        : undefined;
    const lineage = callerLineage(caller);
    const session = this.options.authority.session(context.caller);
    if (caller.kind === "connection" && !session)
      throw new OpensteerError({
        code: "forbidden",
        message: "Plugin authority ended before execution.",
      });
    const mode = session?.operation.mode ?? caller.accessMode;
    const assertConnection = async (database: OpensteerStore["database"], lock: boolean) => {
      if (!lineage) return;
      const connection = await database
        .selectFrom("agentConnections")
        .select(["grantRevision", "accessMode"])
        .where("id", "=", lineage.agentConnectionId)
        .where("userId", "=", caller.userId)
        .where("revokedAt", "is", null)
        .where("tokenHash", "is not", null)
        .where("expiresAt", ">", new Date())
        .$if(lock, (query) => query.forShare())
        .executeTakeFirst();
      if (
        !connection ||
        connection.grantRevision !== lineage.revision ||
        !threadAccessModeAtMost(mode, connection.accessMode)
      )
        throw new OpensteerError({
          code: "forbidden",
          message: "Plugin authority ended before execution.",
        });
    };
    const submission = new AbortController();
    this.#submissions.set(id, submission);
    try {
      await commitPersonalMutation(this.options.store.database, async (tx) => {
        await assertConnection(tx, true);
        await new PluginAgentStore(tx).insert({
          id,
          ownerUserId: caller.userId,
          threadId:
            caller.kind === "run"
              ? caller.thread.id
              : caller.kind === "program"
                ? caller.anchor.id
                : session!.operation.taskId,
          agentSessionId: session?.operation.sessionId ?? null,
          runId: caller.kind === "run" ? caller.claims.runId : null,
          occurrenceId:
            caller.kind === "program" && caller.program.kind === "trigger"
              ? caller.program.occurrenceId
              : null,
          watchActivationId:
            caller.kind === "program" && caller.program.kind === "watch"
              ? caller.program.activationId
              : null,
          connectionId: lineage?.agentConnectionId ?? null,
          admittedGrantRevision: lineage?.revision ?? null,
          admittedAccessMode: mode,
          caller: context.caller,
          mode: context.mode,
          state: "running",
          requestId: null,
          interactionId: null,
          handoff: false,
          result: null,
          reason: null,
        });
      });
      const lifetime = signal ? AbortSignal.any([submission.signal, signal]) : submission.signal;
      const beforeSend = async (engineProcess: EngineProcess | null) => {
        const database = this.options.store.database;
        if (engineProcess) {
          const reserved = await database
            .updateTable("pluginExecutions")
            .set({ engineProcess })
            .where("id", "=", id)
            .where("state", "=", "running")
            .where("terminalEvidenceAt", "is", null)
            .executeTakeFirst();
          if (reserved.numUpdatedRows !== 1n)
            throw new OpensteerError({
              code: "forbidden",
              message: "Plugin authority ended before execution.",
            });
        }
        await assertConnection(database, false);
      };
      try {
        return await this.#invoke(caller, id, () =>
          call
            ? this.options.service.call(call, context, lifetime, beforeSend)
            : this.options.service.execute(program!, context, lifetime, beforeSend),
        );
      } catch (error) {
        if (!this.options.service.executionWasSent(id))
          await this.#record({
            id,
            caller: context.caller,
            state: "cancelled",
            interaction: null,
            drained: true,
          });
        throw error;
      }
    } finally {
      this.#submissions.delete(id);
    }
  }
  async #invoke(caller: AgentCaller, id: string, work: () => Promise<PluginExecution>) {
    let execution: PluginExecution;
    try {
      execution = await work();
    } catch (error) {
      await this.#reports;
      const row = await this.options.records.execution(id);
      const lost = error instanceof PluginServiceError && error.code === "interrupted";
      if (
        row &&
        (row.state === "interrupted" || (lost && this.options.service.executionWasSent(id)))
      ) {
        await this.#record({
          id,
          caller: row.caller,
          state: "interrupted",
          interaction: null,
          reason: pluginInterruptedReason,
        });
        if (caller.kind === "connection") throw new OperationOutcomeUnknown();
        return this.result((await this.options.records.execution(id))!);
      }
      throw error;
    }
    await this.#reports;
    const result = await this.#consume(caller, execution);
    if (caller.kind === "connection" && result.status === "interrupted")
      throw new OperationOutcomeUnknown();
    return result;
  }
  async #consume(caller: AgentCaller, execution: PluginExecution) {
    await this.#record(execution);
    let row = await this.#owned(caller, execution.id);
    if (
      execution.state === "waiting" &&
      execution.interaction &&
      row.interactionId !== execution.interaction.requestId
    ) {
      const interaction = execution.interaction;
      const invocation = object.parse(interaction.invocation ?? interaction.tool);
      const pluginId = z.string().parse(invocation.app);
      const tool = z.string().parse(invocation.tool);
      // A local provider (device app or local server) is not an engine plugin; the Host names it.
      const local = await this.options.localName?.(this.#context(row), pluginId);
      const name =
        local ??
        (
          await this.options.service.list(
            {},
            {
              caller: "personal",
              mode: "automatic",
            },
          )
        ).find(({ id }) => id === pluginId)?.name ??
        "Plugin";
      const version = String(invocation.version);
      const [settings, authors] = await Promise.all([
        this.options.records.settings(caller.userId),
        this.options.records.versionAuthors(caller.userId, [{ pluginId, version }]),
      ]);
      const plugin = {
        id: pluginId,
        name: name.slice(0, 240),
        author:
          authors.get(`${pluginId}\u0000${version}`) ??
          settings.find((s) => s.pluginId === pluginId)?.author ??
          ("agent" as const),
      };
      if (!(await this.#authorizeExecution(row, "answer", pluginId)))
        return this.result((await this.options.records.execution(row.id))!);
      const kind = interaction.status === "approval-required" ? "plugin.approval" : "plugin.input";
      const decision =
        kind === "plugin.approval"
          ? {
              kind: "approval" as const,
              executionId: execution.id,
              tool,
              arguments: invocation.input ?? null,
            }
          : {
              kind: "input" as const,
              executionId: execution.id,
              tool,
              schema: object.parse(interaction.elicitation.requestedSchema),
            };
      if (JSON.stringify(decision).length > 60_000) {
        await this.options.service.cancel({ execution: execution.id }, this.#context(row));
        throw new OpensteerError({
          code: "bad_request",
          message: "Plugin interaction is too large to present exactly in Needs you.",
          next: "Reduce the call's arguments or input form. Earlier calls may have taken effect; check current state before starting new work.",
        });
      }
      const presentation: RequestPresentation = {
        kind: kind === "plugin.approval" ? "choice" : "external",
        title: (row.agentSessionId ? `${name} needs your input` : `${name}: ${tool}`).slice(0, 240),
        detail:
          kind === "plugin.approval"
            ? "Review the exact arguments below. Earlier code in this tool or program may already have run."
            : String(interaction.elicitation.message ?? "This plugin needs your input.").slice(
                0,
                20000,
              ),
        plugin: { plugin, decision },
        ...(kind === "plugin.approval"
          ? {
              options: [
                { id: "accept", label: "Allow once", hint: "allow-once" as const },
                { id: "decline", label: "Decline", hint: "reject-once" as const },
              ],
            }
          : { subject: { kind: "plugin.input", id: execution.id } }),
      } as RequestPresentation;
      const previous = row;
      try {
        // The Request exists only if the execution is still waiting for this interaction.
        row = await commitPersonalMutation(this.options.store.database, async (transaction) => {
          const created = await this.options.store.requests.create(
            {
              callId: `plugin:${execution.id}:${interaction.requestId}`,
              kind,
              mode: "durable",
              originatingThreadId: previous.threadId,
              requestedBy: previous.ownerUserId,
              requiredActor: "owner",
              ...(previous.agentSessionId
                ? { originatingAgentSessionId: previous.agentSessionId }
                : previous.runId
                  ? { originatingRunId: previous.runId }
                  : previous.occurrenceId
                    ? { originatingOccurrenceId: previous.occurrenceId }
                    : { originatingWatchActivationId: previous.watchActivationId! }),
              payload: { kind, executionId: execution.id, interactionId: interaction.requestId },
              presentation,
            },
            transaction,
          );
          const attached = await this.options.records.attachInteraction(
            transaction,
            previous,
            created.request.id,
            interaction.requestId,
          );
          if (!attached) throw interactionEnded;
          return attached;
        });
      } catch (error) {
        if (error !== interactionEnded) throw error;
        row = await this.#owned(caller, execution.id);
      }
    }
    return this.result(row, true);
  }
  #context(row: PluginExecutionRecord): PluginCaller {
    return { caller: row.caller, mode: row.mode };
  }
  async #authorizeExecution(row: PluginExecutionRecord, operation: string, plugin?: string) {
    if (
      !terminal.has(row.state) &&
      row.mode === "automatic" &&
      (await this.options.authority.currentMode(row.caller)) !== "automatic"
    ) {
      await this.#end(
        row,
        "plugin-interrupted",
        `Plugin authority changed. ${pluginInterruptedReason}`,
      );
      return false;
    }
    const request = row.requestId ? await this.options.store.requests.get(row.requestId) : null;
    await this.options.authority.assert(
      this.#context(row),
      operation,
      plugin ?? request?.presentation.plugin?.plugin.id,
      row.id,
    );
    return true;
  }
  async #owned(caller: AgentCaller, id: string) {
    const row = await this.options.records.execution(id);
    const context = pluginCaller(caller);
    if (
      !row ||
      row.ownerUserId !== caller.userId ||
      pluginCallerSubject(row.caller) !== context.caller
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Plugin execution is unavailable to this caller.",
        next: "Use only an executionId returned to this task or program.",
      });
    return row;
  }
  result(row: PluginExecutionRecord, includeData = false) {
    const data = includeData && row.state === "completed" ? row.result?.data : undefined;

    return {
      executionId: row.id,
      status:
        row.state === "waiting" || row.state === "answered" || row.state === "running"
          ? "pending"
          : row.state,
      ...(row.requestId ? { requestId: row.requestId } : {}),
      ...(data === undefined ? {} : { result: data }),
      ...(row.reason ? { reason: row.reason } : {}),
      next:
        row.state === "completed"
          ? data === undefined
            ? "The result is unavailable. Check the current state before continuing."
            : "Read the result before continuing."
          : terminal.has(row.state)
            ? (row.reason ?? "Plugin execution ended.") +
              " Earlier calls may have taken effect. Check current state before starting new work; never rerun blindly."
            : `Waiting on the person in Needs you. Do not repeat or poll. After the person answers, call plugin_resume({executionId:${JSON.stringify(row.id)}}).`,
    };
  }
  #savedResult(row: PluginExecutionRecord) {
    return row.state === "completed"
      ? z
          .object({ data: object, targets: operations.resultAccess.input.shape.targets })
          .safeParse(row.result).data
      : undefined;
  }
  async terminalResult(caller: AgentCaller, row: PluginExecutionRecord, signal?: AbortSignal) {
    const saved = this.#savedResult(row);
    const mode = row.admittedAccessMode;
    if (!saved || !mode) return this.result(row);
    const includeData = await this.options.authority.scoped(caller, async () => {
      const context = { ...this.options.authority.admit(caller), mode: "ask" as const };
      if (!(await this.options.authority.canReadResult(context, mode))) return false;
      const allowed = await this.options.service
        .request("resultAccess", { targets: saved.targets }, context, signal)
        .catch((error: unknown) => {
          signal?.throwIfAborted();
          if (error instanceof PluginServiceError) return false;
          throw error;
        });
      return allowed && this.options.authority.canReadResult(context, mode);
    });
    return this.result(row, includeData);
  }
  async replayOperation(
    caller: ConnectionCaller,
    operation: AgentOperationRow & { taskId: ThreadId; sessionStatus: string },
    signal?: AbortSignal,
  ) {
    const executionId = operation.resultSummary?.executionId;
    if (
      typeof executionId !== "string" ||
      operation.sessionStatus === "ended" ||
      operation.grantRevision !== caller.grantRevision ||
      operation.target.grant.kind !== "plugin"
    )
      return;
    const live = await this.options.store
      .admitExecution({
        ownerUserId: caller.userId,
        subject: { kind: "binding", bindingId: `session:${operation.sessionId}` },
      })
      .catch(() => null);
    const grant = live?.agentConnection?.grant;
    if (
      !live ||
      !grant ||
      live.agentConnection?.grantRevision !== operation.grantRevision ||
      !threadAccessModeAtMost(operation.mode, live.mode) ||
      !agentGrantAccess(grant, operation.target.grant)
    )
      return;
    const row = await this.sessionExecution(caller, executionId, operation.taskId);
    if (row.agentSessionId !== operation.sessionId) return;
    return this.terminalResult(caller, row, signal);
  }
  async sessionExecution(caller: ConnectionCaller, id: string, taskId: ThreadId) {
    const row = await this.#owned(caller, id);
    const agentSessionId = row.agentSessionId;
    if (!agentSessionId || row.threadId !== taskId || row.connectionId !== caller.connectionId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Plugin execution is unavailable to this caller.",
      });
    return { ...row, agentSessionId };
  }
  async resumeSession(caller: ConnectionCaller, id: string, taskId: ThreadId, signal: AbortSignal) {
    return this.#drive(id, async () => {
      const row = await this.sessionExecution(caller, id, taskId);
      if (terminal.has(row.state)) return this.terminalResult(caller, row, signal);
      const session = this.options.authority.session(row.caller);
      if (!session) throw new OperationOutcomeUnknown();
      session.signal = signal;
      try {
        return await this.#resume(caller, row, signal);
      } finally {
        delete session.signal;
      }
    });
  }
  async stopSession(bindingId: string) {
    const session = AgentSessionIdSchema.safeParse(bindingId.slice("session:".length));
    if (!bindingId.startsWith("session:") || !session.success) return;
    const rows = await this.options.store.database
      .selectFrom("pluginExecutions")
      .selectAll()
      .where("agentSessionId", "=", session.data)
      .where("terminalEvidenceAt", "is", null)
      .execute();
    await Promise.all(
      rows.map(async (row) => {
        const result = await this.#stopExecution(row);
        if (result) await this.#record(result);
      }),
    );
  }
  async resume(caller: AgentCaller, id: string, signal?: AbortSignal) {
    return this.#drive(id, async () => {
      let row = await this.#owned(caller, id);
      if (terminal.has(row.state)) {
        await this.options.authority.scoped(caller, () =>
          this.options.authority.assert(
            { ...this.options.authority.admit(caller), mode: "ask" },
            "resume",
          ),
        );
        return this.terminalResult(caller, row, signal);
      }
      if (!(await this.#authorizeExecution(row, "resume")))
        return this.result((await this.options.records.execution(id))!);
      if (caller.kind === "run" && (await this.#answerReady(row))) {
        await this.options.store.assertActiveGrant(caller.claims);
        const taken = await this.options.records.takeForRun(row, caller.claims.runId);
        if (!taken) return this.result(await this.#owned(caller, id));
        row = taken;
        this.options.authority.transfer(row.caller, caller);
      }
      return this.#resume(caller, row, signal);
    });
  }
  async #resume(caller: AgentCaller, row: PluginExecutionRecord, signal?: AbortSignal) {
    if (terminal.has(row.state)) return this.terminalResult(caller, row, signal);
    if (!(await this.#authorizeExecution(row, "resume")))
      return this.result((await this.options.records.execution(row.id))!);
    if (!(await this.#answerReady(row))) return this.result(row);
    return this.#invoke(caller, row.id, () =>
      this.options.service.resume({ execution: row.id }, this.#context(row), signal),
    );
  }
  async #answerReady(row: PluginExecutionRecord) {
    if (row.state !== "answered" || !row.requestId) return false;
    const request = await this.options.store.requests.get(row.requestId);
    return request?.status === "fulfilled" || request?.status === "declined";
  }
  async #drive<T>(id: string, work: () => Promise<T>) {
    if (this.#drivers.has(id))
      throw new OpensteerError({
        code: "conflict",
        message: "Plugin execution already has a driver.",
        next: "Wait for the existing plugin call to return; do not submit it again.",
      });
    this.#drivers.add(id);
    try {
      return await work();
    } finally {
      this.#drivers.delete(id);
    }
  }
  async respond(input: {
    requestId: RequestId;
    expectedRevision: string;
    resolvedBy: UserId;
    settlementSessionId?: string;
    response: RequestResponse;
  }) {
    const request = await this.options.store.requests.get(input.requestId);
    // A late answer reports what interrupted the execution, including engine loss.
    if (
      request?.requestedBy === input.resolvedBy &&
      request.status === "cancelled" &&
      request.cancellationReason === "plugin-interrupted"
    ) {
      const { payload } = request;
      const reason =
        payload.kind === "plugin.approval" || payload.kind === "plugin.input"
          ? ((await this.options.records.execution(payload.executionId))?.reason ??
            pluginInterruptedReason)
          : "Plugin authority changed.";
      throw new OpensteerError({
        code: "conflict",
        message: reason,
      });
    }
    if (!request || request.requestedBy !== input.resolvedBy || request.status !== "pending")
      throw new OpensteerError({ code: "forbidden", message: "Plugin Request is unavailable." });
    if ((await this.options.store.requests.revision(request.id)) !== input.expectedRevision)
      throw new OpensteerError({
        code: "conflict",
        reason: "request-changed",
        message: "Request changed; read it again before answering",
      });
    if (request.payload.kind === "plugin.account") {
      const declined =
        input.response.kind === "external" && input.response.value?.decision === "declined";
      if (!declined)
        throw new OpensteerError({
          code: "bad_request",
          message: "Connect or link an account to fulfil this Request.",
          next: "Use the plugin account linking flow, or dismiss the Request.",
        });
      return this.#settle(input, "declined");
    }
    if (request.payload.kind !== "plugin.approval" && request.payload.kind !== "plugin.input")
      throw new OpensteerError({ code: "bad_request", message: "This is not a plugin Request." });
    const id = request.payload.executionId;
    if (this.#answers.has(id))
      throw new OpensteerError({
        code: "conflict",
        message: "This plugin answer is already being delivered.",
      });
    this.#answers.add(id);
    try {
      const row = await this.options.records.execution(id);
      if (!row || terminal.has(row.state) || row.interactionId !== request.payload.interactionId)
        throw new OpensteerError({ code: "conflict", message: "Plugin interaction has ended." });
      if (!(await this.#authorizeExecution(row, "answer")))
        throw new OpensteerError({
          code: "conflict",
          message: `Plugin authority changed. ${pluginInterruptedReason}`,
        });
      const response =
        request.payload.kind === "plugin.approval"
          ? {
              action:
                input.response.kind === "choice" && input.response.optionId === "accept"
                  ? ("accept" as const)
                  : ("decline" as const),
            }
          : z
              .object({
                action: z.enum(["accept", "decline", "cancel"]),
                content: object.optional(),
              })
              .parse(input.response.kind === "external" ? input.response.value : undefined);
      const execution = await this.options.service.answer(
        { execution: id, response },
        this.#context(row),
      );
      await this.#reports;
      if (execution.state !== "answered")
        throw new OpensteerError({
          code: "conflict",
          message: "Plugin interaction expired before the answer arrived.",
        });
      const settled = await this.#settle(
        input,
        response.action === "accept" ? "fulfilled" : "declined",
      );
      this.#changes.emit(id);
      return settled;
    } finally {
      this.#answers.delete(id);
    }
  }
  async #settle(
    input: {
      requestId: RequestId;
      expectedRevision: string;
      resolvedBy: UserId;
      settlementSessionId?: string;
    },
    decision: "fulfilled" | "declined",
  ) {
    const result = await this.options.store.requests.settlePluginRequest({ ...input, decision });
    return result;
  }
  async hold(input: {
    caller: RunCaller;
    record: Record<string, unknown>;
    limitMs: number;
    signal: AbortSignal;
    steersAtAdmission: number;
    admittedAt: number;
  }) {
    const id = z.string().parse(input.record.executionId);
    return this.#drive(id, async () => {
      const deadline = input.admittedAt + input.limitMs;
      for (;;) {
        const changed = Promise.withResolvers<void>();
        const wake = () => changed.resolve();
        this.#changes.once(id, wake);
        this.#changes.once("run", wake);
        input.signal.addEventListener("abort", wake, { once: true });
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        try {
          let row = await this.#owned(input.caller, id);
          if (terminal.has(row.state)) return this.terminalResult(input.caller, row, input.signal);
          if (await this.#answerReady(row)) {
            if (row.requestId) {
              const delivered = await this.options.store.requests.markToolDelivered(
                row.requestId,
                input.caller.claims,
              );
              if (delivered === "refused")
                return this.result(await this.options.records.update(id, { handoff: true }));
            }
            const result = await this.#resume(input.caller, row, input.signal);
            if (result.status !== "pending") return result;
            continue;
          }
          const snapshot = row.requestId
            ? await this.options.store.requests.holdSnapshot(
                row.requestId,
                input.caller.claims.runId,
                input.steersAtAdmission,
              )
            : null;
          if (
            input.signal.aborted ||
            !snapshot ||
            snapshot.run.phase !== "turn" ||
            snapshot.run.voiceSessionId !== null ||
            Date.now() >= deadline ||
            snapshot.queued ||
            snapshot.steered
          ) {
            row = await this.options.records.update(id, { handoff: true });
            if (!input.signal.aborted && snapshot && (snapshot.queued || Date.now() >= deadline)) {
              await this.options.store.stopHeldRun(
                input.caller.claims,
                snapshot.queued ? "queued-input" : "limit",
              );
            }
            return this.result(row);
          }
          await changed.promise;
        } finally {
          clearTimeout(timer);
          this.#changes.off(id, wake);
          this.#changes.off("run", wake);
          input.signal.removeEventListener("abort", wake);
        }
      }
    });
  }
  observe(
    reaction: Extract<
      PersonalCommitReaction,
      {
        type: "runChanged" | "runFinished" | "requestChanged";
      }
    >,
  ) {
    this.#changes.emit("run");
    if (
      reaction.type === "runFinished" &&
      !reaction.attemptOnly &&
      reaction.outcome === "interrupted"
    )
      void this.stopRun(reaction.runId).catch(this.options.onError);
    if (
      reaction.type === "requestChanged" &&
      (reaction.kind === "plugin.approval" || reaction.kind === "plugin.input") &&
      (reaction.status === "cancelled" || reaction.status === "withdrawn")
    )
      void this.#cancelSettled(reaction.requestId).catch(this.options.onError);
  }
  async #cancelSettled(requestId: RequestId) {
    const row = await this.options.records.unfinishedRequest(requestId);
    if (row) await this.#cancel(row);
  }
  async stopRun(runId: RunId) {
    const stops = await this.options.store.database
      .selectFrom("commands")
      .select("authoritySource")
      .where("runId", "=", runId)
      .where("type", "=", "run.interrupt")
      .execute();
    const stopped = stops.some((command) => command.authoritySource.kind !== "request-hold");
    for (const row of await this.options.records.unfinished()) {
      if (row.runId !== runId || (row.handoff && !stopped)) continue;
      await this.#cancel(row);
    }
  }
  async cancelPlugin(owner: UserId, plugin: string) {
    const ids = new Set(this.options.authority.executionsFor(plugin));
    const requests = await this.options.store.database
      .selectFrom("requests")
      .select("id")
      .where("requestedBy", "=", owner)
      .where("kind", "=", "plugin.account")
      .where("status", "=", "pending")
      .where((eb) => eb(eb.ref("payload", "->>").key("plugin"), "=", plugin))
      .execute();
    if (requests.length)
      await this.options.store.requests.cancelPluginRequests(
        requests.map(({ id }) => id),
        "plugin-interrupted",
      );
    if (ids.size)
      for (const row of await this.options.records.unfinished())
        if (row.ownerUserId === owner && ids.has(row.id))
          await this.#end(
            row,
            "plugin-interrupted",
            `Plugin authority changed. ${pluginInterruptedReason}`,
          );
  }
  async stopConnectionExecution(
    id: string,
    connectionId: string,
  ): Promise<void | "ended" | "contact-lost"> {
    const row = await this.options.records.execution(id);
    if (
      !row ||
      (row.connectionId !== null && row.connectionId !== connectionId) ||
      row.terminalEvidenceAt
    )
      return;
    if (await this.#stopExecution(row)) return "ended";
    if (
      row.engineProcess &&
      (await this.options.service.executionContactLost(row.id, row.engineProcess))
    )
      return "contact-lost";
  }
  #stopExecution(row: PluginExecutionRecord) {
    const submission = this.#submissions.get(row.id);
    submission?.abort();
    return this.options.service.stopExecution(row.id, this.#context(row), Boolean(submission));
  }
  async #cancel(row: PluginExecutionRecord) {
    await this.#end(
      row,
      "run-ended",
      "The Run stopped. Earlier calls may have taken effect; check current state before repeating work.",
    );
  }
  async #end(
    row: PluginExecutionRecord,
    cause: "plugin-interrupted" | "run-ended",
    reason: string,
  ) {
    const ended = await this.options.records.updateLive(
      row.id,
      { state: cause === "run-ended" ? "cancelled" : "interrupted", reason, result: null },
      cause === "run-ended" ? row.runId : undefined,
    );
    if (!ended) return;
    void this.#stopExecution(row)
      .then((proof) => proof && this.#record(proof))
      .catch(this.options.onError);
    if (ended.requestId)
      await this.options.store.requests.endPluginExecutionRequest(ended.requestId, cause);
    this.#changes.emit(row.id);
  }
  async close() {
    await this.#reports;
    this.#changes.removeAllListeners();
  }
}
