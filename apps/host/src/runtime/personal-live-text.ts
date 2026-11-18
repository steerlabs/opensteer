import { randomUUID } from "node:crypto";
import {
  surrogateSafeCut,
  type ExecutionNodeId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import { toolCallId, transcriptIdentity } from "@opensteer/database";
import type { PersonalLiveUpdate, RealtimeHub } from "@opensteer/orchestration";
import type { RunnerToHostMessage } from "@opensteer/protocol";
import type { PersonalScope, ScopedClientMessage } from "@opensteer/protocol/personal-sync";

import { markdownBoundary, scanMarkdown } from "./markdown-live-boundary.js";

type RunnerLive = Extract<RunnerToHostMessage, { type: "runner.live" }>;
type Replacement = Extract<PersonalLiveUpdate["update"], { operation: "replace" }>;
type TextFrame = PersonalLiveUpdate & { update: Replacement };
type Paragraph = {
  readonly scan: ReturnType<typeof scanMarkdown>;
  readonly boundary: number;
  through: number;
  lastFlushAt: number;
  pendingSince: number;
  maxAt: number;
  quietAt: number;
  dueAt: number;
};

type DetailScope = Exclude<PersonalScope, { kind: "shell" }>;
type Resync = Extract<ScopedClientMessage, { type: "client.live.resync" }>;
type Stream = {
  readonly scope: DetailScope;
  readonly subject?: DetailScope;
  readonly frame: PersonalLiveUpdate;
  readonly bytes: number;
  readonly paragraph?: Paragraph;
};
type Binding = {
  readonly attemptId: RunAttemptId;
  readonly bindingGeneration: number;
  readonly threadId: ThreadId;
};
type TrackedBinding = Binding & { readonly nodes: Map<ExecutionNodeId, ExecutionNodeId | null> };

const maxStreamText = 12 * 1024;
const maxRunStreams = 16;
const maxHostBytes = 16 * 1024 * 1024;
const maxBindings = 4096;
const paragraphIntervalMs = 400;
const paragraphQuietMs = 800;

function boundedTail(text: string) {
  const bytes = Buffer.from(text);
  let from = Math.max(0, bytes.length - maxStreamText);
  while ((bytes[from]! & 0xc0) === 0x80) from++;
  return bytes.subarray(from).toString("utf8");
}

function textThrough(frame: TextFrame, through: number): TextFrame {
  if (through === frame.update.totalLength) return frame;
  const text = frame.update.text.slice(0, through - frame.update.offset);
  return {
    ...frame,
    update: {
      ...frame.update,
      text,
      totalLength: through,
      incomplete: text.length < through,
    },
  };
}

function boundFrame(frame: TextFrame): number {
  let bytes = Buffer.byteLength(JSON.stringify(frame));
  while (bytes > 15 * 1024 && frame.update.text) {
    const { text, totalLength } = frame.update;
    frame.update.text = text.slice(surrogateSafeCut(text, Math.floor(text.length / 2)));
    frame.update.offset = totalLength - frame.update.text.length;
    frame.update.incomplete = true;
    bytes = Buffer.byteLength(JSON.stringify(frame));
  }
  return bytes;
}

function matches(a: DetailScope, b: DetailScope) {
  return (
    a.threadId === b.threadId &&
    (a.kind === "node" ? b.kind === "node" && a.nodeId === b.nodeId : b.kind === "thread")
  );
}

export class PersonalLiveText {
  readonly #bootId = randomUUID();
  readonly #bindings = new Map<RunId, TrackedBinding>();
  readonly #runs = new Map<RunId, Map<string, Stream>>();
  #bytes = 0;
  readonly #hub: Pick<RealtimeHub, "publishLive">;
  readonly #pending = new Set<Stream>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = Infinity;
  readonly #request: (runId: RunId) => void;
  readonly #repairs = new Set<RunId>();

  constructor(hub: Pick<RealtimeHub, "publishLive">, request: (runId: RunId) => void) {
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
    this.#bindings.set(runId, { ...binding, nodes: new Map() });
    const oldest = this.#bindings.keys().next().value;
    if (this.#bindings.size > maxBindings && oldest) {
      this.#dropRun(oldest);
      this.#bindings.delete(oldest);
    }
  }

  placeNode(
    change: Extract<PersonalCommitReaction, { type: "nodeProgressPlacement" }>,
    afterSequence: string,
  ) {
    const binding = this.#bindings.get(change.runId);
    if (!binding || binding.attemptId !== change.attemptId) return;
    const prior = binding.nodes.get(change.nodeId);
    const itemId = `node:${change.nodeId}`;
    if (!change.active) {
      binding.nodes.delete(change.nodeId);
      this.closeItem({
        type: "liveClosed",
        runId: change.runId,
        threadId: binding.threadId,
        attemptId: change.attemptId,
        bindingGeneration: binding.bindingGeneration,
        nodeId: change.parentNodeId,
        itemId,
        afterSequence,
      });
      return;
    }
    if (prior === undefined && binding.nodes.size >= 256) return;
    binding.nodes.set(change.nodeId, change.parentNodeId);
    const streams = this.#runs.get(change.runId);
    const stream = streams?.get(itemId);
    if (!stream || prior === change.parentNodeId) return;
    const scope: DetailScope = change.parentNodeId
      ? { kind: "node", threadId: binding.threadId, nodeId: change.parentNodeId }
      : { kind: "thread", threadId: binding.threadId };
    const frame = { ...stream.frame, afterSequence };
    streams?.set(itemId, { ...stream, scope, frame });
    this.#hub.publishLive(scope, frame, { replace: true });
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
      const parentNodeId = item.stream === "node" ? binding.nodes.get(item.nodeId) : null;
      if (parentNodeId === undefined) continue;
      const nodeId = item.stream === "tool" ? (item.nodeId ?? null) : parentNodeId;
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
            : item.stream === "node"
              ? `node:${item.nodeId}`
              : `tool:${toolCallId({ runId, attemptId, bindingGeneration, nodeId, callId: item.callId })}`;
      if (!itemId) continue;
      const existing = streams.get(itemId);
      const previous = existing?.frame.update;
      if (previous?.operation === "close") continue;
      const continuing = item.op === "append" && (previous?.totalLength ?? 0) === item.at;
      const prefix = continuing ? (previous?.text ?? "") : "";
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
      const frame: TextFrame = {
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
      if (existing) this.#pending.delete(existing);
      this.#bytes -= existing?.bytes ?? 0;
      streams.delete(itemId);
      const bytes = boundFrame(frame);
      if (bytes > 15 * 1024) continue;
      const now = Date.now();
      const paragraph =
        item.stream === "assistant" || item.stream === "reasoning"
          ? this.#paragraph(frame, continuing ? existing?.paragraph : undefined, now)
          : undefined;
      const subject: DetailScope | undefined =
        item.stream === "node" ? { kind: "node", threadId, nodeId: item.nodeId } : undefined;
      const stream: Stream = {
        scope,
        frame,
        bytes,
        ...(paragraph ? { paragraph } : {}),
        ...(subject ? { subject } : {}),
      };
      streams.set(itemId, stream);
      this.#bytes += bytes;
      if (streams.size > maxRunStreams) {
        const oldest = streams.keys().next().value!;
        const evicted = streams.get(oldest)!;
        this.#pending.delete(evicted);
        this.#bytes -= evicted.bytes;
        streams.delete(oldest);
      }
      while (this.#bytes > maxHostBytes) {
        const oldest = this.#runs.keys().next().value;
        if (!oldest) break;
        this.#dropRun(oldest);
      }
      if (this.#runs.get(runId) !== streams) continue;
      if (paragraph) this.#flushParagraph(stream, now, !continuing);
      else {
        this.#hub.publishLive(scope, frame);
        if (subject) this.#hub.publishLive(subject, frame);
      }
    }
    if (streams.size === 0) this.#runs.delete(runId);
    if (!this.#pending.size) this.#clearTimer();
  }

  #paragraph(frame: TextFrame, previous: Paragraph | undefined, now: number): Paragraph {
    const { text, offset } = frame.update;
    const scan = scanMarkdown(text, offset, previous?.scan);
    const pending = previous && Number.isFinite(previous.dueAt);
    const lastFlushAt = previous?.lastFlushAt ?? -Infinity;
    const pendingSince = pending ? previous.pendingSince : now;
    return {
      scan,
      boundary: markdownBoundary(scan, text, offset),
      through: previous?.through ?? 0,
      lastFlushAt,
      pendingSince,
      maxAt: pending ? Math.max(pendingSince, lastFlushAt) + paragraphIntervalMs : Infinity,
      quietAt: now + paragraphQuietMs,
      dueAt: Infinity,
    };
  }

  #flushParagraph(stream: Stream, now: number, replace = false) {
    const paragraph = stream.paragraph!;
    if (stream.frame.update.operation !== "replace") return;
    const frame = { ...stream.frame, update: stream.frame.update };
    const { totalLength, offset } = frame.update;
    const boundary =
      paragraph.boundary > Math.max(paragraph.through, offset) ? paragraph.boundary : Infinity;
    const boundaryAt = Number.isFinite(boundary)
      ? paragraph.lastFlushAt + paragraphIntervalMs
      : Infinity;
    const through =
      replace || now >= Math.min(paragraph.maxAt, paragraph.quietAt)
        ? totalLength
        : now >= boundaryAt
          ? boundary
          : paragraph.through;
    let dueAt = Infinity;
    if (replace || through > paragraph.through) {
      paragraph.through = through;
      paragraph.lastFlushAt = now;
      paragraph.pendingSince = now;
      paragraph.maxAt = Infinity;
      this.#hub.publishLive(stream.scope, textThrough(frame, through), {
        immediate: true,
        replace,
      });
      if (through < totalLength) dueAt = paragraph.quietAt;
    } else if (through < totalLength) {
      dueAt = Math.min(boundaryAt, paragraph.maxAt, paragraph.quietAt);
    }
    paragraph.dueAt = dueAt;
    if (Number.isFinite(dueAt)) {
      this.#pending.add(stream);
      this.#armTimer(dueAt);
    } else {
      this.#pending.delete(stream);
    }
  }

  #armTimer(at: number) {
    if (at >= this.#timerAt) return;
    this.#clearTimer();
    this.#timerAt = at;
    this.#timer = setTimeout(
      () => {
        this.#clearTimer();
        const now = Date.now();
        for (const stream of this.#pending) {
          if (stream.paragraph!.dueAt <= now) this.#flushParagraph(stream, now);
          else this.#armTimer(stream.paragraph!.dueAt);
        }
      },
      Math.max(0, at - Date.now()),
    );
    this.#timer.unref();
  }

  #clearTimer() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Infinity;
  }

  read(scope: DetailScope, request?: Resync): PersonalLiveUpdate[] {
    const out: PersonalLiveUpdate[] = [];
    let bytes = 0;
    const runs = request ? [this.#runs.get(request.runId)] : [...this.#runs.values()].reverse();
    for (const streams of runs) {
      for (const { scope: owner, subject, frame, bytes: size, paragraph } of streams?.values() ??
        []) {
        if (
          (!matches(owner, scope) && (!subject || !matches(subject, scope))) ||
          frame.update.operation === "close" ||
          (request && !request.streamIds.includes(frame.streamId))
        )
          continue;
        if (frame.update.operation !== "replace") continue;
        const through = paragraph?.through ?? frame.update.totalLength;
        if (through <= frame.update.offset && through !== frame.update.totalLength) continue;
        if (bytes + size > 32 * 1024) return out;
        out.push(textThrough({ ...frame, update: frame.update }, through));
        bytes += size;
      }
    }
    if (
      request &&
      request.streamIds.some((id) => !this.#runs.get(request.runId)?.has(id)) &&
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
    this.#pending.delete(stream);
    if (!this.#pending.size) this.#clearTimer();
    streams?.set(change.itemId, { ...stream, frame, bytes });
    this.#bytes += bytes - stream.bytes;
    this.#hub.publishLive(stream.scope, frame, { immediate: stream.paragraph !== undefined });
    if (stream.subject) this.#hub.publishLive(stream.subject, frame);
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

  close() {
    this.#clearTimer();
    this.#pending.clear();
    this.#runs.clear();
    this.#bindings.clear();
    this.#repairs.clear();
    this.#bytes = 0;
  }

  #dropRun(runId: RunId) {
    this.#repairs.delete(runId);
    for (const stream of this.#runs.get(runId)?.values() ?? []) {
      this.#pending.delete(stream);
      this.#bytes -= stream.bytes;
    }
    if (!this.#pending.size) this.#clearTimer();
    this.#runs.delete(runId);
  }
}
