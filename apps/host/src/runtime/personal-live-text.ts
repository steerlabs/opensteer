import { randomUUID } from "node:crypto";
import type { RunAttemptId, RunId, ThreadId } from "@opensteer/core";
import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import { toolCallId, transcriptIdentity } from "@opensteer/database";
import type { PersonalLiveUpdate, RealtimeHub } from "@opensteer/orchestration";
import type { RunnerToHostMessage } from "@opensteer/protocol";
type RunnerLive = Extract<RunnerToHostMessage, { type: "runner.live" }>;
import type { PersonalScope, ScopedClientMessage } from "@opensteer/protocol/personal-sync";

type DetailScope = Exclude<PersonalScope, { kind: "shell" }>;
type Resync = Extract<ScopedClientMessage, { type: "client.live.resync" }>;
type Stream = {
  readonly scope: DetailScope;
  readonly frame: PersonalLiveUpdate;
  readonly bytes: number;
};
type Binding = {
  readonly attemptId: RunAttemptId;
  readonly bindingGeneration: number;
  readonly threadId: ThreadId;
};

const maxStreamText = 12 * 1024;
const maxRunStreams = 16;
const maxHostBytes = 16 * 1024 * 1024;
const maxBindings = 4096;

function boundedTail(text: string) {
  const bytes = Buffer.from(text);
  let from = Math.max(0, bytes.length - maxStreamText);
  while ((bytes[from]! & 0xc0) === 0x80) from++;
  return bytes.subarray(from).toString("utf8");
}

function matches(a: DetailScope, b: DetailScope) {
  return (
    a.threadId === b.threadId &&
    (a.kind === "node" ? b.kind === "node" && a.nodeId === b.nodeId : b.kind === "thread")
  );
}

export class PersonalLiveText {
  readonly #bootId = randomUUID();
  readonly #bindings = new Map<RunId, Binding>();
  readonly #runs = new Map<RunId, Map<string, Stream>>();
  #bytes = 0;
  readonly #hub: RealtimeHub;
  readonly #request: (runId: RunId) => void;
  readonly #repairs = new Set<RunId>();

  constructor(hub: RealtimeHub, request: (runId: RunId) => void) {
    this.#hub = hub;
    this.#request = request;
  }

  knows(runId: RunId, bindingGeneration: number) {
    return this.#bindings.get(runId)?.bindingGeneration === bindingGeneration;
  }

  track(runId: RunId, binding: Binding) {
    const previous = this.#bindings.get(runId);
    if (previous && previous.bindingGeneration >= binding.bindingGeneration) return;
    if (previous) this.#dropRun(runId);
    this.#bindings.set(runId, binding);
    const oldest = this.#bindings.keys().next().value;
    if (this.#bindings.size > maxBindings && oldest) {
      this.#dropRun(oldest);
      this.#bindings.delete(oldest);
    }
  }

  accept(live: RunnerLive, afterSequence: string) {
    const { runId, threadId } = live.progress;
    const binding = this.#bindings.get(runId);
    if (
      !binding ||
      binding.bindingGeneration !== live.bindingGeneration ||
      binding.threadId !== threadId
    )
      return;
    const { attemptId, bindingGeneration } = binding;
    const streams = this.#runs.get(runId) ?? new Map<string, Stream>();
    this.#runs.delete(runId);
    this.#runs.set(runId, streams);
    for (const item of live.progress.items) {
      if (item.stream === "node") continue;
      const nodeId = item.stream === "tool" ? (item.nodeId ?? null) : null;
      const scope: DetailScope = nodeId
        ? { kind: "node", threadId, nodeId }
        : { kind: "thread", threadId };
      const itemId =
        item.stream === "assistant"
          ? live.assistantMessageId
          : item.stream === "reasoning"
            ? transcriptIdentity(
                "reasoning",
                runId,
                attemptId,
                bindingGeneration,
                nodeId,
                item.blockId,
              )
            : `tool:${toolCallId({ runId, attemptId, bindingGeneration, nodeId, callId: item.callId })}`;
      if (!itemId) continue;
      const existing = streams.get(itemId);
      const previous = existing?.frame.update;
      if (previous?.operation === "close") continue;
      const prefix = item.op === "append" && previous?.totalLength === item.at ? previous.text : "";
      const totalLength = item.op === "append" ? item.at + item.text.length : item.length;
      const text = boundedTail(prefix + item.text);
      const base = {
        liveBootId: this.#bootId,
        runId,
        attemptId,
        bindingGeneration,
        itemId,
        streamId: itemId,
        afterSequence,
      };
      const createdAt = existing?.frame.item?.createdAt ?? new Date().toISOString();
      const card = {
        id: itemId,
        revision: afterSequence,
        position: "1",
        runId,
        attemptId,
        nodeId,
        isTurnStart: false,
        createdAt,
        view: {},
      };
      const preview: PersonalLiveUpdate["item"] =
        item.stream === "assistant" && live.assistantMessageId
          ? {
              ...card,
              kind: "message",
              messageId: live.assistantMessageId,
              messageKind: "assistant",
            }
          : item.stream === "reasoning"
            ? { ...card, kind: "reasoning", blockId: item.blockId, bindingGeneration }
            : undefined;
      const frame: PersonalLiveUpdate = {
        ...base,
        ...(preview ? { item: preview } : {}),
        update: {
          operation: "replace",
          text,
          totalLength,
          offset: totalLength - text.length,
          incomplete: text.length < totalLength,
        },
      };
      this.#bytes -= existing?.bytes ?? 0;
      streams.delete(itemId);
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (bytes > 15 * 1024) continue;
      streams.set(itemId, { scope, frame, bytes });
      this.#bytes += bytes;
      if (streams.size > maxRunStreams) {
        const oldest = streams.keys().next().value!;
        this.#bytes -= streams.get(oldest)!.bytes;
        streams.delete(oldest);
      }
      while (this.#bytes > maxHostBytes) {
        const oldest = this.#runs.keys().next().value;
        if (!oldest) break;
        this.#dropRun(oldest);
      }
      this.#hub.publishLive(scope, frame);
    }
    if (streams.size === 0) this.#runs.delete(runId);
  }

  read(scope: DetailScope, request?: Resync): PersonalLiveUpdate[] {
    const out: PersonalLiveUpdate[] = [];
    let bytes = 0;
    const runs = request ? [this.#runs.get(request.runId)] : [...this.#runs.values()].reverse();
    for (const streams of runs) {
      for (const { scope: owner, frame, bytes: size } of streams?.values() ?? []) {
        if (
          !matches(owner, scope) ||
          frame.update.operation === "close" ||
          (request && !request.streamIds.includes(frame.streamId))
        )
          continue;
        if (bytes + size > 32 * 1024) return out;
        out.push(frame);
        bytes += size;
      }
    }
    if (
      request &&
      out.length < request.streamIds.length &&
      this.#bindings.get(request.runId)?.threadId === scope.threadId &&
      !this.#repairs.has(request.runId)
    ) {
      this.#repairs.add(request.runId);
      this.#request(request.runId);
    }
    return out;
  }

  closeItem(change: Extract<PersonalCommitReaction, { type: "liveClosed" }>) {
    const streams = this.#runs.get(change.runId);
    const stream = streams?.get(change.itemId);
    if (
      !stream ||
      stream.frame.attemptId !== change.attemptId ||
      stream.frame.bindingGeneration !== change.bindingGeneration
    )
      return;
    const { item: _item, ...identity } = stream.frame;
    const frame: PersonalLiveUpdate = {
      ...identity,
      afterSequence: change.afterSequence,
      update: { operation: "close" },
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    streams?.set(change.itemId, { ...stream, frame, bytes });
    this.#bytes += bytes - stream.bytes;
    this.#hub.publishLive(stream.scope, frame);
  }

  finish(change: Extract<PersonalCommitReaction, { type: "runFinished" }>, afterSequence: string) {
    if (!this.knows(change.runId, change.bindingGeneration ?? 0)) return;
    for (const { frame, scope } of this.#runs.get(change.runId)?.values() ?? []) {
      this.closeItem({
        ...change,
        type: "liveClosed",
        itemId: frame.itemId,
        nodeId: scope.kind === "node" ? scope.nodeId : null,
        afterSequence,
      });
    }
    this.#dropRun(change.runId);
    this.#bindings.delete(change.runId);
  }

  #dropRun(runId: RunId) {
    this.#repairs.delete(runId);
    for (const { bytes } of this.#runs.get(runId)?.values() ?? []) this.#bytes -= bytes;
    this.#runs.delete(runId);
  }
}
