import { z } from "zod";
import { ProtocolErrorSchema } from "@opensteer/protocol";
import { LiveProgressBuffer } from "./live-progress.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import {
  ProjectRunBindingSchema,
  type ProjectRunBinding,
  type ExecutionNodeId,
} from "@opensteer/core";
import {
  RunnerAuxiliaryRequestIdSchema,
  ProjectExecutableCommandSchema,
  ProjectHostToRunnerMessageSchema,
  ProjectPendingRunEventSchema,
  type ProjectExecuteRun,
  type ProjectExecutableCommand,
  type ProjectExecutionBinding,
  type ProjectHostToRunnerMessage,
  type ProjectRunnerOperationalReport,
  type RunnerConnectionFence,
} from "@opensteer/protocol";
import { isHarnessLiveEvent, type ProjectHarnessSession } from "@opensteer/harness";
import type { CommandDecision } from "../agent/command-ledger.js";

export type ProjectReport = ProjectRunnerOperationalReport;
export interface ProjectSink {
  sendProject(message: ProjectReport): Promise<void>;
}
export interface ProjectExecutionEntry {
  readonly binding: ProjectExecutionBinding;
  readonly abort: AbortController;
  readonly journal: Map<number, ProjectReport>;
  readonly credentials: { agentTools: string; attachments?: string; egress: string; mcp?: string };
  deadline: number;
  ordinal: number;
  journalBytes: number;
  terminal: boolean;
  revoked: boolean;
  session?: ProjectHarnessSession;
  sessionBound?: ProjectReport;
  task?: Promise<void>;
  stop?: () => Promise<void>;
  renewed?: (remainingMs: number) => void;
  credentialsChanged?: () => void;
}
interface Options {
  readonly bootId: string;
  readonly environmentId: string;
  readonly privateDirectory: string;
  readonly maxConcurrent: number;
  readonly now?: () => number;
  readonly start: (
    command: ProjectExecuteRun,
    entry: ProjectExecutionEntry,
  ) => Promise<{ session: ProjectHarnessSession; cleanup(): Promise<void> }>;
  readonly programs: (
    command: Exclude<ProjectExecutableCommand, ProjectExecuteRun>,
    runtime: ProjectExecution,
  ) => Promise<CommandDecision>;
}
const denied = (message: string): CommandDecision => ({
  status: "rejected",
  error: { code: "forbidden", message, retryable: false },
});
const address = (binding: ProjectExecutionBinding) => canonicalJson(binding);
const runAddress = (binding: ProjectRunBinding) => address({ ...binding, kind: "run" });

export class ProjectExecution {
  readonly #options: Options;
  readonly #entries = new Map<string, ProjectExecutionEntry>();
  readonly #commands = new Map<string, { fingerprint: string; result: Promise<CommandDecision> }>();
  readonly #controlEffects = new Map<string, { frames: ProjectReport[]; bytes: number }>();
  readonly #controls = new Map<string, { fingerprint: string; result: CommandDecision }>();
  readonly #refreshes = new Map<string, { key: string; deadline: number }>();
  readonly #heartbeats = new Map<string, { at: number; bindings: Set<string> }>();
  #identity?: Pick<RunnerConnectionFence, "runnerId" | "bootId">;
  #sink: ProjectSink | undefined;
  #timer: NodeJS.Timeout | undefined;
  #activated = false;
  #announcedAt: number | undefined;
  #closed = false;
  #controlTail: Promise<void> = Promise.resolve();
  #controlLoaded = false;
  constructor(options: Options) {
    this.#options = options;
  }
  now(): number {
    return this.#options.now?.() ?? Date.now();
  }
  identity(): Pick<RunnerConnectionFence, "runnerId" | "bootId"> {
    if (!this.#identity) throw new Error("Project connection is not authenticated");
    return this.#identity;
  }
  connect(identity: Pick<RunnerConnectionFence, "runnerId" | "bootId">, sink: ProjectSink): void {
    if (
      identity.bootId !== this.#options.bootId ||
      (this.#identity && this.#identity.runnerId !== identity.runnerId)
    )
      throw new Error("Project connection changed Runner identity");
    this.#identity = identity;
    this.#sink = sink;
  }
  disconnect(sink: ProjectSink): void {
    if (this.#sink === sink) this.#sink = undefined;
  }
  async dispatch(raw: ProjectExecutableCommand): Promise<CommandDecision> {
    if (this.#closed) return denied("Runner is stopping");
    const parsed = ProjectExecutableCommandSchema.safeParse(raw);
    if (!parsed.success) return denied("Invalid Project command");
    const command = parsed.data;
    this.#activated = true;
    if (command.environmentId !== this.#options.environmentId || !this.#identity)
      return denied("Project command targets a different Runner");
    const contexts =
      command.type === "watch.reconcile.project" ? command.desired : [command.context];
    if (contexts.some((context) => context.runnerBootId !== this.#identity?.bootId))
      return denied("Project command targets a different Runner boot");
    const fingerprint = createHash("sha256").update(canonicalJson(command)).digest("hex");
    const previous = this.#commands.get(command.commandId);
    if (previous)
      return previous.fingerprint === fingerprint
        ? previous.result
        : denied("Project command identity reused");
    if (this.#commands.size >= 10_000) return denied("Project command ledger is full");
    const result = Promise.resolve()
      .then(async () => {
        if (command.type !== "run.execute.project") return this.#options.programs(command, this);
        const context = command.context;
        const binding = ProjectRunBindingSchema.parse({
          authority: context.authority,
          bindingGeneration: context.bindingGeneration,
          environmentId: context.environmentId,
          grantId: context.grantId,
          runId: context.runId,
          runnerBootId: context.runnerBootId,
          runnerId: this.identity().runnerId,
          threadId: context.threadId,
          workspaceId: context.workspaceId,
        });
        if (
          [...this.#entries.values()].some(
            (entry) =>
              entry.binding.kind === "run" &&
              !entry.terminal &&
              entry.binding.threadId === context.threadId,
          )
        )
          return denied("Project Thread already has an active Run");
        if (
          [...this.#entries.values()].filter((entry) => !entry.terminal).length >=
          this.#options.maxConcurrent
        )
          return denied("Project execution capacity is full");
        const entry = this.admit({ ...binding, kind: "run" }, context.executionLeaseMs);
        entry.ordinal = context.firstOrdinal ?? 0;
        Object.assign(entry.credentials, {
          agentTools: context.agentTools.token,
          egress: context.egress.relayToken,
          ...(context.attachments ? { attachments: context.attachments.token } : {}),
        });
        // Command receipts reach the connection before engine callbacks can publish.
        entry.task = new Promise<void>((resolve) =>
          setImmediate(() => {
            void this.#execute(command, entry).finally(resolve);
          }),
        );
        return { status: "accepted" } as const;
      })
      .catch(() => denied("Project command could not be admitted"));
    this.#commands.set(command.commandId, { fingerprint, result });
    return result;
  }
  admit(binding: ProjectExecutionBinding, leaseMs: number): ProjectExecutionEntry {
    if (
      binding.runnerId !== this.identity().runnerId ||
      binding.runnerBootId !== this.identity().bootId ||
      binding.environmentId !== this.#options.environmentId
    )
      throw new Error("Project binding targets a different Runner");
    this.#timer ??= setInterval(() => {
      for (const entry of this.#entries.values())
        if (!entry.terminal && entry.deadline <= this.now()) this.revoke(entry);
    }, 250);
    this.#timer.unref();
    const key = address(binding);
    if (this.#entries.size >= 1000) throw new Error("Project binding ledger is full");
    if (this.#entries.has(key)) throw new Error("Project binding is already held");
    const entry: ProjectExecutionEntry = {
      binding,
      abort: new AbortController(),
      journal: new Map(),
      credentials: { agentTools: "", egress: "" },
      deadline: this.now() + leaseMs,
      ordinal: 0,
      journalBytes: 0,
      terminal: false,
      revoked: false,
    };
    this.#entries.set(key, entry);
    return entry;
  }
  async emit(entry: ProjectExecutionEntry, message: ProjectReport): Promise<void> {
    if (entry.revoked || this.#entries.get(address(entry.binding)) !== entry) return;
    if (
      entry.journal.size >= 10_000 ||
      entry.journalBytes + Buffer.byteLength(JSON.stringify(message)) > 16 * 1024 * 1024
    ) {
      this.revoke(entry);
      throw new Error("Project event journal is full");
    }
    entry.journalBytes += Buffer.byteLength(JSON.stringify(message));
    entry.journal.set(entry.ordinal++, message);
    await this.#send(message).catch(() => undefined);
  }
  async #execute(command: ProjectExecuteRun, entry: ProjectExecutionEntry): Promise<void> {
    let cleanup: (() => Promise<void>) | undefined;
    const binding = ProjectRunBindingSchema.parse(commandBinding(entry));
    let terminalSeen = false;
    const toolNodeIds = new Map<string, ExecutionNodeId>();
    const live = new LiveProgressBuffer({
      flushIntervalMs: 50,
      maxInFlightBytes: 512 * 1024,
      maxPendingBytes: 256 * 1024,
      maxSentBytes: 16 * 1024 * 1024,
      send: async (items) => {
        if (!entry.revoked)
          await this.#send({
            type: "runner.project.live",
            binding,
            progress: {
              runId: binding.runId,
              threadId: binding.threadId,
              workspaceId: binding.workspaceId,
              items: [...items],
            },
          });
      },
    });
    try {
      entry.abort.signal.throwIfAborted();
      const opened = await this.#options.start(command, entry);
      cleanup = opened.cleanup;
      entry.session = opened.session;
      entry.sessionBound = {
        type: "runner.project.session-bound",
        binding,
        harnessInstanceId: command.context.harnessInstanceId,
        providerSessionId: command.context.providerSessionId,
        providerSessionReference: opened.session.providerSessionReference,
        engineStart: "cold",
      };
      await this.#send(entry.sessionBound).catch(() => undefined);
      const consume = (async () => {
        for await (const event of opened.session.events) {
          if (entry.revoked) break;
          if (
            event.type === "request.proposed.project" &&
            canonicalJson(event.binding) !== canonicalJson(binding)
          )
            throw new Error("Project engine proposal changed its binding");
          if (event.type !== "request.proposed.project" && isHarnessLiveEvent(event)) {
            if (event.type === "assistant.delta")
              live.append({ stream: "assistant" }, event.data.text);
            else if (event.type === "reasoning.delta")
              live.append({ stream: "reasoning", blockId: event.data.blockId }, event.data.text);
            else if (event.type === "tool.delta") {
              const nodeId = toolNodeIds.get(event.data.callId);
              live.append(
                { stream: "tool", callId: event.data.callId, ...(nodeId ? { nodeId } : {}) },
                event.data.text,
              );
            } else if (event.type === "node.progress")
              live.replaceNode(event.data.nodeId, event.data.text);
            else {
              void (event satisfies never);
              throw new Error("Unsupported Project live progress event");
            }
            continue;
          }
          if (["run.completed", "run.failed", "run.interrupted"].includes(event.type))
            terminalSeen = true;
          await live.flush();
          const pending = ProjectPendingRunEventSchema.parse({
            ...event,
            binding,
            ordinal: entry.ordinal,
            emittedAt: new Date().toISOString(),
          });
          await this.emit(entry, { type: "runner.project.event", event: pending });
          if (event.type === "tool.started" && event.data.nodeId)
            toolNodeIds.set(event.data.callId, event.data.nodeId);
          if (event.type === "node.completed")
            live.complete({ stream: "node", nodeId: event.data.nodeId });
          if (event.type === "assistant.message") live.complete({ stream: "assistant" });
          if (event.type === "reasoning.completed" && !event.data.nodeId)
            live.complete({ stream: "reasoning", blockId: event.data.blockId });
          if (event.type === "tool.completed") {
            toolNodeIds.delete(event.data.callId);
            live.complete({ stream: "tool", callId: event.data.callId });
          }
        }
      })();
      const execution = opened.session.execute({
        executionAuthority: { kind: "project", binding },
        runId: binding.runId,
        context: {
          assignment: command.context.assignment,
          threadState: command.context.threadState,
          projectTimeZone: command.context.projectTimeZone,
          projectSettingsRevision: command.context.projectSettingsRevision,
        },
        environment: {},
        inputs: command.inputs,
        reports: command.reports,
        signal: entry.abort.signal,
      });
      await Promise.race([execution, consume]);
      await execution;
      await opened.session.stop();
      await consume;
      if (!terminalSeen) throw new Error("Project engine ended without a terminal event");
    } catch {
      entry.abort.abort(new Error("Project execution failed"));
      if (!terminalSeen && !entry.revoked && entry.binding.kind === "run")
        await this.emit(entry, {
          type: "runner.project.event",
          event: {
            binding: ProjectRunBindingSchema.parse(commandBinding(entry)),
            ordinal: entry.ordinal,
            emittedAt: new Date().toISOString(),
            type: "run.failed",
            data: {
              code: "runner_execution_error",
              message: "Project execution failed",
              retryable: false,
              status: "failed",
            },
          },
        });
    } finally {
      live.close();
      entry.terminal = true;
      await entry.session?.stop().catch(() => undefined);
      await cleanup?.().catch(() => undefined);
      if (entry.revoked) this.#entries.delete(address(entry.binding));
    }
  }
  async announce(): Promise<void> {
    if (!this.#activated) return;
    this.#announcedAt = this.now();
    await this.#sink?.sendProject({
      type: "runner.project.executions.attach",
      complete: true,
      executions: [...this.#entries.values()]
        .filter((entry) => !entry.revoked)
        .map((entry) => ({
          binding: entry.binding,
          nextOrdinal: entry.ordinal,
          terminal: entry.terminal,
        })),
    });
  }
  async heartbeat(sentAt: string): Promise<void> {
    if (!this.#activated) return;
    const bindings = [...this.#entries.values()]
      .filter((entry) => !entry.revoked && !entry.terminal)
      .map((entry) => entry.binding);
    this.#heartbeats.set(sentAt, { at: this.now(), bindings: new Set(bindings.map(address)) });
    while (this.#heartbeats.size > 100)
      this.#heartbeats.delete(this.#heartbeats.keys().next().value!);
    await this.#sink?.sendProject({ type: "runner.project.heartbeat", sentAt, bindings });
    for (const binding of bindings) {
      const key = address(binding);
      for (const [id, refresh] of this.#refreshes)
        if (refresh.deadline <= this.now()) this.#refreshes.delete(id);
      if ([...this.#refreshes.values()].some((refresh) => refresh.key === key)) continue;
      const requestId = RunnerAuxiliaryRequestIdSchema.parse(randomUUID());
      this.#refreshes.set(requestId, { key, deadline: this.now() + 30000 });
      await this.#sink?.sendProject({ type: "runner.project.grants.refresh", requestId, binding });
    }
  }
  async handle(raw: ProjectHostToRunnerMessage): Promise<void> {
    const message = ProjectHostToRunnerMessageSchema.parse(raw);
    this.#activated = true;
    if (message.runnerId !== this.identity().runnerId || message.bootId !== this.identity().bootId)
      throw new Error("Project frame targets a different Runner incarnation");
    switch (message.type) {
      case "host.project.executions.renewed": {
        const heartbeat = this.#heartbeats.get(message.heartbeatSentAt);
        if (!heartbeat) return;
        for (const binding of message.bindings) {
          const key = address(binding),
            entry = this.#entries.get(key);
          if (
            heartbeat.bindings.has(key) &&
            entry &&
            !entry.revoked &&
            entry.deadline > this.now()
          ) {
            entry.deadline = Math.max(entry.deadline, heartbeat.at + message.leaseMs);
            entry.renewed?.(entry.deadline - this.now());
          }
        }
        return;
      }
      case "host.project.executions.revoked":
        for (const item of message.revocations) {
          const entry = this.#entries.get(address(item.binding));
          if (entry) this.revoke(entry);
        }
        return;
      case "host.project.events.acked":
        for (const ack of message.acks) {
          const entry = this.#entries.get(address(ack.binding));
          if (!entry || ack.throughOrdinal >= entry.ordinal) continue;
          for (const [ordinal, frame] of entry.journal) {
            if (ordinal <= ack.throughOrdinal) {
              entry.journalBytes -= Buffer.byteLength(JSON.stringify(frame));
              entry.journal.delete(ordinal);
            }
          }
          if (ack.sessionBound) delete entry.sessionBound;
          if (entry.terminal && !entry.journal.size && !entry.sessionBound)
            this.#entries.delete(address(entry.binding));
        }
        return;
      case "host.project.executions.attached":
        for (const result of message.results) {
          const entry = this.#entries.get(address(result.binding));
          if (!entry) continue;
          if (result.status === "revoked") {
            this.revoke(entry);
            continue;
          }
          if (result.nextOrdinal > entry.ordinal) {
            this.revoke(entry);
            continue;
          }
          if (!entry.terminal && this.#announcedAt !== undefined) {
            if (entry.deadline <= this.now()) {
              this.revoke(entry);
              continue;
            }
            entry.deadline = Math.max(entry.deadline, this.#announcedAt + message.leaseMs);
            entry.renewed?.(entry.deadline - this.now());
          }
          if (entry.sessionBound) await this.#send(entry.sessionBound);
          for (const [ordinal, frame] of entry.journal)
            if (ordinal >= result.nextOrdinal) await this.#send(frame);
        }
        return;
      case "host.project.grants.credentials": {
        const key = address(message.binding);
        if (this.#refreshes.get(message.requestId)?.key !== key) return;
        this.#refreshes.delete(message.requestId);
        const entry = this.#entries.get(key);
        if (!entry || entry.revoked || entry.deadline <= this.now()) return;
        if (message.result.status === "refused") this.revoke(entry);
        else if (message.result.status === "issued") {
          Object.assign(entry.credentials, message.result.credentials);
          entry.credentialsChanged?.();
        }
        return;
      }
      case "host.project.run-control": {
        const apply = this.#controlTail.then(() => this.#control(message));
        this.#controlTail = apply.catch(() => undefined);
        await apply;
      }
    }
  }
  async #control(
    message: Extract<ProjectHostToRunnerMessage, { type: "host.project.run-control" }>,
  ): Promise<void> {
    const file = join(
      this.#options.privateDirectory,
      `project-controls-${createHash("sha256").update(this.#options.bootId).digest("hex")}.json`,
    );
    if (!this.#controlLoaded) {
      try {
        const contents = await readFile(file, "utf8");
        if (Buffer.byteLength(contents) > 8 * 1024 * 1024)
          throw new Error("Project control ledger exceeds its byte limit");
        const rows = z
          .array(
            z.tuple([
              z.string().min(1),
              z.strictObject({
                fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
                result: z.discriminatedUnion("status", [
                  z.strictObject({ status: z.literal("accepted") }),
                  z.strictObject({ status: z.literal("rejected"), error: ProtocolErrorSchema }),
                  z.strictObject({
                    status: z.literal("uncertain"),
                    message: z.string().min(1).max(2000),
                  }),
                ]),
              }),
            ]),
          )
          .max(10_000)
          .parse(JSON.parse(contents));
        for (const [id, row] of rows) this.#controls.set(id, row);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      this.#controlLoaded = true;
    }
    const fingerprint = createHash("sha256")
      .update(canonicalJson({ binding: message.binding, control: message.control }))
      .digest("hex");
    const previous = this.#controls.get(message.commandId);
    let result: CommandDecision;
    if (previous)
      result =
        previous.fingerprint === fingerprint
          ? previous.result
          : denied("Project control identity reused");
    else {
      const entry = this.#entries.get(runAddress(message.binding));
      result = denied("Project binding is no longer held");
      if (entry && !entry.revoked && !entry.terminal && entry.deadline > this.now()) {
        if (this.#controls.size >= 10_000) throw new Error("Project control ledger is full");
        this.#controls.set(message.commandId, {
          fingerprint,
          result: { status: "uncertain", message: "Project control outcome was not recorded" },
        });
        await mkdir(this.#options.privateDirectory, { recursive: true, mode: 0o700 });
        await replacePrivateFileAtomically(file, JSON.stringify([...this.#controls]));
        this.#controlEffects.set(runAddress(message.binding), { frames: [], bytes: 0 });
        try {
          const control = message.control;
          if (control.kind === "run.interrupt") this.revoke(entry);
          else if (!entry.session) result = denied("Project engine is not ready");
          else {
            if (control.kind === "request.resolve")
              await entry.session.resolveRequest(control.requestId, control.response);
            else if (control.kind === "request.refuse")
              await entry.session.refuseRequest(control.requestId, control.callId, control.reason);
            else {
              if (!entry.session.steer) throw new Error("Project engine cannot steer");
              await entry.session.steer({ input: control.input });
            }
            result = { status: "accepted" };
          }
          if (control.kind === "run.interrupt") result = { status: "accepted" };
        } catch {
          result = { status: "uncertain", message: "Project provider control outcome is unknown" };
        }
      }
      this.#controls.set(message.commandId, { fingerprint, result });
      await mkdir(this.#options.privateDirectory, { recursive: true, mode: 0o700 });
      await replacePrivateFileAtomically(file, JSON.stringify([...this.#controls]));
    }
    await this.#sink?.sendProject({
      type: "runner.project.control-result",
      binding: message.binding,
      commandId: message.commandId,
      correlationId: message.correlationId,
      result,
    });
    const key = runAddress(message.binding);
    const effects = this.#controlEffects.get(key);
    try {
      if (effects) for (const frame of effects.frames) await this.#sink?.sendProject(frame);
    } finally {
      this.#controlEffects.delete(key);
    }
  }
  async #send(message: ProjectReport): Promise<void> {
    const binding =
      message.type === "runner.project.event"
        ? message.event.binding
        : "binding" in message
          ? message.binding
          : undefined;
    const effects =
      binding && "runId" in binding ? this.#controlEffects.get(runAddress(binding)) : undefined;
    if (effects) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (effects.bytes + bytes > 1024 * 1024)
        throw new Error("Project control event buffer is full");
      effects.frames.push(message);
      effects.bytes += bytes;
      return;
    }
    await this.#sink?.sendProject(message);
  }
  revoke(entry: ProjectExecutionEntry): void {
    entry.revoked = true;
    entry.abort.abort(new Error("Project execution authority ended"));
    void entry.session?.interrupt().catch(() => undefined);
    void entry.stop?.().catch(() => undefined);
    entry.journal.clear();
    entry.journalBytes = 0;
    delete entry.sessionBound;
    if (!entry.task) this.#entries.delete(address(entry.binding));
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    const entries = [...this.#entries.values()];
    for (const entry of entries) this.revoke(entry);
    await Promise.allSettled(entries.flatMap((entry) => (entry.task ? [entry.task] : [])));
    await this.#controlTail;
  }
}
function commandBinding(entry: ProjectExecutionEntry): Omit<ProjectExecutionBinding, "kind"> {
  const { kind: _kind, ...binding } = entry.binding;
  return binding;
}
