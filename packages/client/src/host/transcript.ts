import { BrowserSignInRequestResponseSchema } from "@opensteer/protocol/browser-sources";
import { browserSiteLabel } from "./browser-sign-in.js";
import { passwordSignInOutcome, passwordSignInReceipt } from "./passwords.js";
import {
  contentSaysSomething,
  threadInputIsPublished,
  type ThreadInput,
  requestOptionDeclines,
  requestTitleText,
  type AgentEventView as AgentEvent,
  type LiveStreamKey,
  type MessageKind,
  type MessageView,
  type Request,
  type RunUsage,
  type ThreadInputPolicy,
  type ThreadInputQueue,
} from "@opensteer/core";
import { liveStreamText, type LiveRunView } from "./live-progress.js";
import type {
  AssignmentEntry,
  AssignmentReturnEntry,
  DelegationEntry,
  DeliveryEntry,
  MessageEntry,
  ReasoningEntry,
  RequestReceiptEntry,
  RunEntry,
  RunEntryStatus,
  ToolEntry,
  TranscriptEntry,
} from "./client.js";

/**
 * The transcript reducer. Folds the durable agent event stream into ordered,
 * structure-preserving entries. It is pure and idempotent per event, and is
 * shared by the live realtime path and durable history restoration so a
 * refreshed page reconstructs exactly what a live session saw.
 *
 * Ordering: entries keep their first-arrival slot (the workspace sequence
 * order) and are updated in place as their lifecycle progresses.
 */
export function foldTranscriptEvent(
  entries: readonly TranscriptEntry[],
  event: AgentEvent,
): TranscriptEntry[] {
  switch (event.type) {
    case "run.queued":
    case "thread.input-queue-updated":
    case "thread.state-changed":
      return [...entries];
    case "run.started":
      return upsertRunEntry(entries, event, "running");
    case "run.status":
      return upsertRunEntry(entries, event, event.data.status);
    // The Run goes back to its queue for the attempt that takes the message.
    case "run.restarted": {
      const restarted = upsertRunEntry(
        stopRunNodes(entries, event.runId, event.createdAt),
        event,
        "queued",
      );
      const entry = findEntry(restarted, `run:${event.runId}`, "run");
      if (!entry) return restarted;
      const { priorUsage: _replaced, usage: _usage, ...rest } = entry;
      return upsertEntry(restarted, {
        ...rest,
        attempt: event.data.attempt,
        ...(event.data.priorUsage
          ? { priorUsage: event.data.priorUsage, usage: event.data.priorUsage }
          : {}),
      });
    }
    case "run.phase": {
      const id = event.runId ? `run:${event.runId}` : `event:${event.eventId}`;
      // A history page can hold a turn's reply without the Run's start: the
      // Run is running, and the reply is still its turn's.
      const prior =
        findEntry(entries, id, "run") ??
        findEntry(upsertRunEntry(entries, event, "running"), id, "run")!;
      const startedBy = event.data.startedBy ?? prior.startedBy;
      const reply = event.data.phase === "background" ? event.data.replyMessageId : null;
      const turnReplies =
        reply && !prior.turnReplyMessageIds?.includes(reply)
          ? [...(prior.turnReplyMessageIds ?? []), reply]
          : prior.turnReplyMessageIds;
      // A turn's reply stands even when the Run's end arrived first.
      if (isTerminalRunEntryStatus(prior.status)) {
        return upsertEntry(entries, {
          ...prior,
          ...runContext(prior, event),
          ...(startedBy ? { startedBy } : {}),
          ...(turnReplies ? { turnReplyMessageIds: turnReplies } : {}),
        });
      }
      const { background: _background, ...rest } = prior;
      return upsertEntry(entries, {
        ...rest,
        ...runContext(prior, event),
        ...(startedBy ? { startedBy } : {}),
        ...(event.data.phase === "background" ? { background: true } : {}),
        ...(turnReplies ? { turnReplyMessageIds: turnReplies } : {}),
      });
    }
    case "run.usage": {
      // Usage says nothing about where the Run got to; it arrives before the
      // terminal event and leaves the lifecycle exactly as it found it.
      const id = event.runId ? `run:${event.runId}` : `event:${event.eventId}`;
      const prior = findEntry(entries, id, "run");
      if (!prior) return [...entries];
      return upsertEntry(entries, {
        ...prior,
        usage: prior.priorUsage ? addRunUsage(prior.priorUsage, event.data) : event.data,
      });
    }
    case "run.completed":
      return upsertRunEntry(
        finishRunEntries(entries, event.runId, event.createdAt),
        event,
        "completed",
        null,
        event.data.replyMessageId,
      );
    case "run.interrupted":
      return upsertRunEntry(
        finishRunEntries(entries, event.runId, event.createdAt),
        event,
        "interrupted",
      );
    case "run.failed":
      return upsertRunEntry(
        finishRunEntries(entries, event.runId, event.createdAt),
        event,
        "failed",
        {
          code: event.data.code,
          message: event.data.message,
          retryable: event.data.retryable,
        },
      );
    case "assistant.message": {
      const body = messageBody(event.data.content);
      const attachments = event.data.content.filter((part) => part.type === "artifact");
      const pages = event.data.content.filter((part) => part.type === "browser-page");
      const places = event.data.content.filter(
        (part) => part.type === "computer-app" || part.type === "phone",
      );
      const streamId = streamMessageId(event.runId ?? event.threadId);
      const withoutStream = entries.some((entry) => entry.id === streamId);
      const message: MessageEntry = {
        author: event.runId
          ? {
              displayName: "Opensteer",
              kind: "agent",
              runId: event.runId,
              threadId: event.threadId,
              workspaceId: event.workspaceId,
              workspaceName: "Current Workspace",
            }
          : { cause: "assistant-message", kind: "platform" },
        body,
        attachments,
        pages,
        ...(places.length ? { places } : {}),
        createdAt: event.createdAt,
        id: event.data.messageId,
        kind: "message",
        messageKind: "assistant",
        runId: event.runId,
      };
      if (!contentSaysSomething(event.data.content))
        return entries.filter((entry) => entry.id !== streamId);
      if (withoutStream) return replaceEntry(entries, streamId, message);
      return upsertEntry(entries, message);
    }
    case "assignment.created":
    case "assignment.updated": {
      const id = `assignment:${event.data.assignment.id}`;
      const previous = findEntry(entries, id, "assignment");
      const assignment: AssignmentEntry = {
        assignment: event.data.assignment,
        createdAt: previous?.createdAt ?? event.createdAt,
        id,
        kind: "assignment",
        runId: event.runId,
      };
      return upsertEntry(entries, assignment);
    }
    case "delegation.settled": {
      const delegation: DelegationEntry = {
        childRunId: event.data.childRunId,
        childThread: event.data.childThread,
        createdAt: event.createdAt,
        delegationId: event.data.delegationId,
        delivery: event.data.delivery,
        failure: event.data.failure,
        id: `delegation:${event.data.delegationId}`,
        kind: "delegation",
        outcome: event.data.outcome,
        resultPreview: event.data.resultPreview,
        runId: event.runId,
        taskPreview: event.data.taskPreview,
      };
      return upsertEntry(entries, delegation);
    }
    case "reasoning.completed": {
      const id = reasoningEntryId(event.runId, event.data.blockId);
      const prior = findEntry(entries, id, "reasoning");
      if (!event.data.text && !prior?.text) {
        return entries.filter((entry) => entry.id !== id);
      }
      return upsertEntry(entries, {
        completedAt: event.createdAt,
        createdAt: prior?.createdAt ?? event.createdAt,
        id,
        kind: "reasoning",
        runId: event.runId,
        state: "done",
        text: event.data.text || (prior?.text ?? ""),
      });
    }
    case "node.started": {
      const id = nodeEntryId(event.data.nodeId);
      const prior = findEntry(entries, id, "node");
      return upsertEntry(entries, {
        completedAt: prior?.completedAt ?? null,
        createdAt: prior?.createdAt ?? event.createdAt,
        id,
        kind: "node",
        model: prior?.model ?? event.data.model,
        nodeId: event.data.nodeId,
        originCallId: event.data.originCallId,
        parentNodeId: event.data.parentNodeId,
        prompt: prior?.prompt ?? event.data.prompt,
        result: prior?.result ?? null,
        runId: event.runId,
        status: prior?.status ?? "running",
        title: prior?.title ?? event.data.title,
        ...(prior?.usage ? { usage: prior.usage } : {}),
      });
    }
    case "node.updated": {
      const prior = findEntry(entries, nodeEntryId(event.data.nodeId), "node");
      if (!prior) return [...entries];
      return upsertEntry(entries, {
        ...prior,
        ...(event.data.model === undefined ? {} : { model: event.data.model }),
        ...(event.data.originCallId === undefined ? {} : { originCallId: event.data.originCallId }),
        ...(event.data.prompt === undefined ? {} : { prompt: event.data.prompt }),
        ...(event.data.title === undefined ? {} : { title: event.data.title }),
      });
    }
    case "node.completed": {
      const prior = findEntry(entries, nodeEntryId(event.data.nodeId), "node");
      if (!prior) return [...entries];
      const { usage: _usage, ...rest } = prior;
      return upsertEntry(entries, {
        ...rest,
        completedAt: event.createdAt,
        result: event.data.result,
        status: event.data.status,
        ...(event.data.usage ? { usage: event.data.usage } : {}),
      });
    }
    case "tool.started": {
      const id = toolEntryId(event.runId, event.data.callId);
      const prior = findEntry(entries, id, "tool");
      return upsertEntry(entries, {
        arguments: event.data.arguments,
        callId: event.data.callId,
        completedAt: prior?.completedAt ?? null,
        createdAt: prior?.createdAt ?? event.createdAt,
        id,
        integration: event.data.integration ?? null,
        isError: prior?.isError ?? false,
        kind: "tool",
        ...(event.data.nodeId ? { nodeId: event.data.nodeId } : {}),
        output: prior?.output,
        runId: event.runId,
        state: prior && prior.state !== "running" ? prior.state : "running",
        streamText: prior?.streamText ?? "",
        tool: event.data.tool,
      });
    }
    case "tool.completed": {
      const id = toolEntryId(event.runId, event.data.callId);
      const prior = findEntry(entries, id, "tool");
      return upsertEntry(entries, {
        arguments: prior?.arguments,
        callId: event.data.callId,
        completedAt: event.createdAt,
        createdAt: prior?.createdAt ?? event.createdAt,
        id,
        integration: prior?.integration ?? null,
        isError: event.data.isError,
        kind: "tool",
        ...nodeIdOf(event.data.nodeId, prior?.nodeId),
        output: event.data.output,
        runId: event.runId,
        state: event.data.isError ? "failed" : "done",
        streamText: prior?.streamText ?? "",
        tool: prior?.tool ?? null,
      });
    }
    case "request.cancelled": {
      const id = `request:${event.data.requestId}`;
      const wait = findEntry(entries, id, "request-wait");
      return upsertEntry(entries, {
        createdAt: event.createdAt,
        id,
        kind: "request",
        outcome: `Cancelled · ${event.data.reason}`,
        requestId: event.data.requestId,
        requestKind: null,
        runId: event.runId,
        title: "Request",
        ...(wait ? { waitedSince: wait.createdAt } : {}),
      });
    }
    case "request.opened": {
      const { request } = event.data;
      const id = `request:${request.id}`;
      if (request.mode !== "live" || entries.some((entry) => entry.id === id)) return [...entries];
      return upsertEntry(entries, {
        createdAt: request.createdAt,
        id,
        kind: "request-wait",
        requestId: request.id,
        runId: request.originatingRunId,
      });
    }
    case "request.updated":
      return [...entries];
    case "request.resolved":
      return upsertEntry(entries, requestReceipt(event.data.request));
    case "message.created": {
      const entry = toTranscriptEntry(
        {
          ...event.data.message,
          ...(event.data.addressedToUserId
            ? { addressedToUserId: event.data.addressedToUserId }
            : {}),
        },
        event.data.input?.policy,
        event.data.input,
      );
      return entry ? upsertEntry(entries, entry) : [...entries];
    }
    // A queued message belongs where a Run took it, after everything said
    // while it waited, so its entry leaves the place it was sent from. Only a
    // queued input is ever placed.
    case "message.placed": {
      const placed = toTranscriptEntry({ ...event.data.message, published: false }, "queue");
      const rest = entries.filter((entry) => entry.id !== event.data.message.id);
      return placed ? [...rest, placed] : rest;
    }
    // The message itself already entered the transcript when it committed;
    // injection only records that the active Run accepted it.
    case "message.injected":
      return [...entries];
    case "thread-input.updated": {
      const input = event.data.input;
      // A withdrawn message was taken back before any Run could read it, so
      // nothing of it belongs in the conversation. What stays is a marker
      // under its id: a later page carries it even when the message itself
      // sits on an earlier page, and the merge lets it cancel that message.
      if (input.state === "cancelled" && input.cancelReason === "withdrawn") {
        return upsertEntry(entries, {
          createdAt: input.updatedAt,
          id: input.messageId,
          kind: "withdrawn",
        });
      }
      const { state } = input;
      // Back in the queue, a message handed to a Run that never took it — a
      // refusal, or a Run that ended first — waits again, held by no Run until
      // one takes it, exactly as a reload reads it.
      const published = threadInputIsPublished(input);
      const outcome =
        state === "pending"
          ? { delivery: null, waiting: true as const }
          : state === "claimed"
            ? { delivery: null }
            : { delivery: threadInputDelivery({ ...input, state }) };
      const held = entries.find((entry) => entry.id === input.messageId);
      if (held?.kind === "message") {
        const settled = {
          ...withDelivery(held, outcome.delivery),
          published,
          runId: input.runId,
        };
        return entries.map((entry) => (entry === held ? settled : entry));
      }
      // The message is on a page not loaded. The outcome waits under its id,
      // and the merge lands it on the message when that page arrives.
      if (held !== undefined && held.kind !== "delivery") return [...entries];
      return upsertEntry(entries, {
        createdAt: input.updatedAt,
        ...outcome,
        published,
        inputRunId: input.runId,
        id: input.messageId,
        kind: "delivery",
        runId: null,
      });
    }
    case "thread.access-mode-updated":
    case "thread.created":
    case "thread.continuation-established":
    case "thread.listed":
      return [...entries];
    case "thread.execution-updated":
      return upsertEntry(entries, {
        kind: "selection",
        id: event.eventId,
        createdAt: event.createdAt,
        runId: null,
        harnessInstanceId: event.data.thread.harnessInstanceId,
        modelSelection: event.data.thread.modelSelection,
        providerSessionId: event.data.thread.providerSessionId,
      });
  }
}

/**
 * What the conversation says under a message once its input has settled: why
 * it did not, or may not, have reached a Run, or null once it did. Only an
 * input that left the queue other than by withdrawal has an outcome to show.
 */
export function threadInputDelivery(input: {
  readonly cancelReason: string | null;
  readonly policy: ThreadInputPolicy;
  readonly state: "cancelled" | "delivered" | "unknown";
}): MessageEntry["delivery"] | null {
  if (input.state === "delivered") return null;
  if (input.state === "unknown") {
    return { reason: "Message delivery could not be confirmed.", status: "unconfirmed" };
  }
  return { reason: cancellationReason(input), status: "failed" };
}

function withDelivery(
  message: MessageEntry,
  delivery: MessageEntry["delivery"] | null,
): MessageEntry {
  if (delivery) return { ...message, delivery };
  if (!message.delivery) return message;
  const { delivery: _cleared, ...confirmed } = message;
  return confirmed;
}

/**
 * A cancelled steer never reached its Run, and a promoted queue input whose
 * Run ended before receipt is the same story. A message a Stop cancelled
 * before its reply read it was stopped by the reader. Any other cancelled
 * queue input simply never got its turn, and the conversation has to say so
 * rather than show it as sent.
 */
function cancellationReason(input: {
  readonly cancelReason: string | null;
  readonly policy: ThreadInputPolicy;
}): string {
  if (input.cancelReason === "stopped") return "Not sent: you stopped the reply.";
  const detail = input.cancelReason?.replaceAll("-", " ");
  const wasSteer = input.policy === "steer" || input.cancelReason === "run-ended-delivery-unknown";
  if (wasSteer) return detail ? `Steer was not delivered: ${detail}.` : "Steer was not delivered.";
  return detail ? `Not sent: ${detail}.` : "Not sent.";
}

/**
 * Joins an older page of the transcript onto the one already loaded, as if the
 * two pages had been folded as one stream.
 *
 * Each page is folded on its own, so an entry whose lifecycle crosses the
 * boundary exists on both sides: a tool started on the older page and
 * completed on the newer one, a reply streamed on one and finalised on the
 * other, a Run started on one and finished on the other. Such an entry keeps
 * the older page's slot — where it first arrived, which is what decides
 * whether a message came before or after a step — and takes the newer page's
 * state, with what only the older page knew carried forward. Whatever the
 * older page left open for a Run the newer page shows ended is then settled.
 */
export function mergeTranscriptSegments(
  earlier: readonly TranscriptEntry[],
  later: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const earlierIds = new Set(earlier.map((entry) => entry.id));
  const laterById = new Map(later.map((entry) => [entry.id, entry]));
  const consumed = new Set<string>();

  const merged = earlier.flatMap((entry) => {
    const next = counterpart(entry, later, laterById, earlierIds, consumed);
    if (next === undefined) return [entry];
    // A settled message on both pages was placed after it was sent, and the
    // later page holds the place a Run took it at. An outcome the earlier
    // page kept for a message the later page holds is older than that page's
    // own word on it.
    if (next.id === entry.id && isPlacedMessage(entry, next)) return [];
    if (entry.kind === "delivery" && next.kind === "message") return [];
    consumed.add(next.id);
    return [mergeLifecycle(entry, next)];
  });
  let entries = [...merged, ...later.filter((entry) => !consumed.has(entry.id))];
  for (const entry of entries) {
    if (entry.kind === "run" && isTerminalRunEntryStatus(entry.status)) {
      entries = finishRunEntries(entries, entry.runId, entry.endedAt);
    }
  }
  return entries;
}

/**
 * The newer page's version of an older entry. It is usually the same id. A
 * reply the older page only saw stream is the exception: a Run's streamed
 * reply is `stream:<runId>` until its message lands, so the first message of
 * that Run the older page never saw — if it came before any stream of the
 * same id on the newer page — is the message that stream became.
 */
function counterpart(
  entry: TranscriptEntry,
  later: readonly TranscriptEntry[],
  laterById: ReadonlyMap<string, TranscriptEntry>,
  earlierIds: ReadonlySet<string>,
  consumed: ReadonlySet<string>,
): TranscriptEntry | undefined {
  const same = laterById.get(entry.id);
  if (entry.kind !== "message" || entry.streaming !== true || entry.runId === null) return same;
  const finalised = later.find(
    (candidate) =>
      candidate.kind === "message" &&
      candidate.messageKind === "assistant" &&
      !candidate.addressedToUserId &&
      candidate.runId === entry.runId &&
      candidate.streaming !== true &&
      !earlierIds.has(candidate.id) &&
      !consumed.has(candidate.id),
  );
  if (finalised === undefined) return same;
  if (same === undefined) return finalised;
  return later.indexOf(finalised) < later.indexOf(same) ? finalised : same;
}

/**
 * Only `message.created` and `message.placed` make a message entry, so a
 * finished message on two pages means the later page placed it again.
 */
function isPlacedMessage(previous: TranscriptEntry, next: TranscriptEntry): boolean {
  if (previous.kind === "assignment-return") return next.kind === "assignment-return";
  return (
    previous.kind === "message" &&
    next.kind === "message" &&
    previous.streaming !== true &&
    next.streaming !== true
  );
}

function mergeLifecycle(previous: TranscriptEntry, next: TranscriptEntry): TranscriptEntry {
  if (previous.kind === "assignment" && next.kind === "assignment") {
    return {
      ...(next.assignment.revision >= previous.assignment.revision ? next : previous),
      createdAt: previous.createdAt,
    };
  }
  if (previous.kind === "tool" && next.kind === "tool") {
    return {
      ...next,
      arguments: next.arguments ?? previous.arguments,
      createdAt: previous.createdAt,
      integration: next.integration ?? previous.integration,
      streamText: boundedStreamText(`${previous.streamText}${next.streamText}`),
      tool: next.tool ?? previous.tool,
    };
  }
  if (previous.kind === "reasoning" && next.kind === "reasoning") {
    return {
      ...next,
      createdAt: previous.createdAt,
      // A completed block carries its whole text; deltas carry only their own part.
      text:
        next.state === "done" && next.text
          ? next.text
          : boundedStreamText(`${previous.text}${next.text}`),
    };
  }
  if (previous.kind === "run" && next.kind === "run") {
    const usage = next.usage ?? previous.usage;
    const startedBy = next.startedBy ?? previous.startedBy;
    const turnReplies = [
      ...new Set([...(previous.turnReplyMessageIds ?? []), ...(next.turnReplyMessageIds ?? [])]),
    ];
    return {
      ...next,
      createdAt: next.startedAt ?? previous.startedAt ?? previous.createdAt,
      ...((next.startedAt ?? previous.startedAt)
        ? { startedAt: next.startedAt ?? previous.startedAt }
        : {}),
      personWaiting: next.personWaiting === true || previous.personWaiting === true,
      error: next.error ?? previous.error,
      replyMessageId: next.replyMessageId ?? previous.replyMessageId,
      ...(usage === undefined ? {} : { usage }),
      ...(startedBy === undefined ? {} : { startedBy }),
      ...(turnReplies.length > 0 ? { turnReplyMessageIds: turnReplies } : {}),
    };
  }
  // The later page holds what became of a message the earlier page holds.
  if (previous.kind === "message" && next.kind === "delivery") {
    return {
      ...withDelivery(previous, next.delivery),
      published: next.published ?? next.waiting !== true,
      runId:
        next.inputRunId !== undefined
          ? next.inputRunId
          : next.waiting === true
            ? null
            : previous.runId,
    };
  }
  // A wait one page opened ends on the next, as one fold would have ended it.
  if (previous.kind === "request-wait" && next.kind === "request") {
    return next.waitedSince === undefined ? { ...next, waitedSince: previous.createdAt } : next;
  }
  if (previous.kind === "message" && next.kind === "message") {
    if (next.streaming === true && next.id === previous.id) {
      return {
        ...next,
        body: boundedStreamText(`${previous.body}${next.body}`),
        createdAt: previous.createdAt,
      };
    }
    return next;
  }
  return next;
}

/**
 * Draws a Run's live streams over the transcript: the answer it is writing, a
 * reasoning block, or a tool's output. Entries keep the ids their durable
 * events use, so the completing event replaces each one in place. A stream the
 * durable record has already settled is left alone.
 */
export function foldLiveRun(
  entries: readonly TranscriptEntry[],
  run: LiveRunView,
  receivedAt: string,
): TranscriptEntry[] {
  let next = [...entries];
  for (const stream of run.streams) {
    const text = liveStreamText(stream);
    switch (stream.key.stream) {
      case "assistant": {
        const id = streamMessageId(run.runId);
        const prior = findEntry(next, id, "message");
        next = upsertEntry(next, {
          author: {
            displayName: "Opensteer",
            kind: "agent",
            runId: run.runId,
            threadId: run.threadId,
            workspaceId: run.workspaceId,
            workspaceName: "Current Workspace",
          },
          body: text,
          createdAt: prior?.createdAt ?? receivedAt,
          id,
          kind: "message",
          messageKind: "assistant",
          runId: run.runId,
          streaming: true,
        });
        break;
      }
      case "reasoning": {
        const id = reasoningEntryId(run.runId, stream.key.blockId);
        const prior = findEntry(next, id, "reasoning");
        if (prior?.state === "done" || !text) break;
        next = upsertEntry(next, {
          completedAt: null,
          createdAt: prior?.createdAt ?? receivedAt,
          id,
          kind: "reasoning",
          runId: run.runId,
          state: "streaming",
          text,
        });
        break;
      }
      case "tool": {
        const id = toolEntryId(run.runId, stream.key.callId);
        const prior = findEntry(next, id, "tool");
        if (prior && prior.state !== "running") break;
        next = upsertEntry(next, {
          arguments: prior?.arguments,
          callId: stream.key.callId,
          completedAt: null,
          createdAt: prior?.createdAt ?? receivedAt,
          id,
          integration: prior?.integration ?? null,
          isError: prior?.isError ?? false,
          kind: "tool",
          output: prior?.output,
          runId: run.runId,
          state: "running",
          streamText: text,
          tool: prior?.tool ?? null,
        });
        break;
      }
    }
  }
  return next;
}

/** One stream as an entry draws it: the stream `foldLiveRun` wrote into the entry. */
export interface DrawnLiveStream {
  readonly key: LiveStreamKey;
  readonly runId: string;
  readonly text: string;
}

/**
 * The live stream an entry is drawing, or null for an entry in its durable
 * form. Entries keep the ids `foldLiveRun` gave them, which name the stream.
 */
export function drawnLiveStream(entry: TranscriptEntry): DrawnLiveStream | null {
  if (entry.kind === "withdrawn" || entry.runId === null) return null;
  const { runId } = entry;
  if (entry.kind === "message") {
    return entry.streaming === true && entry.id === streamMessageId(runId)
      ? { key: { stream: "assistant" }, runId, text: entry.body }
      : null;
  }
  if (entry.kind === "reasoning") {
    const prefix = reasoningEntryId(runId, "");
    return entry.state === "streaming" && entry.id.startsWith(prefix)
      ? {
          key: { blockId: entry.id.slice(prefix.length), stream: "reasoning" },
          runId,
          text: entry.text,
        }
      : null;
  }
  if (entry.kind === "tool") {
    return entry.state === "running" && entry.streamText !== ""
      ? { key: { callId: entry.callId, stream: "tool" }, runId, text: entry.streamText }
      : null;
  }
  return null;
}

/**
 * The transcript without what it draws of streams that are no longer open: a
 * streaming reply or reasoning block goes, and a running tool keeps the call
 * its durable event recorded but not the output it was streaming. Nothing to
 * drop hands back the same array.
 */
export function withoutClosedLiveStreams(
  entries: readonly TranscriptEntry[],
  open: (runId: string, key: LiveStreamKey) => boolean,
): readonly TranscriptEntry[] {
  let changed = false;
  const next = entries.flatMap((entry): TranscriptEntry[] => {
    const drawn = drawnLiveStream(entry);
    if (drawn === null || open(drawn.runId, drawn.key)) return [entry];
    changed = true;
    // A call with no tool named was only ever drawn from its stream.
    return entry.kind === "tool" && entry.tool !== null ? [{ ...entry, streamText: "" }] : [];
  });
  return changed ? next : entries;
}

/**
 * Settles what a Run left open when it ended. A tool call that never returned
 * is `stopped` however the Run ended: it neither succeeded nor reported an
 * error, and the Run's own outcome says why it ended.
 */
export function finishRunEntries(
  entries: readonly TranscriptEntry[],
  runId: string | null,
  completedAt?: string,
): TranscriptEntry[] {
  if (!runId) return [...entries];
  return entries.map((entry) => {
    if (entry.kind === "withdrawn" || entry.runId !== runId) return entry;
    if (entry.kind === "message" && entry.streaming) return { ...entry, streaming: false };
    if (entry.kind === "reasoning" && entry.state === "streaming")
      return { ...entry, completedAt: completedAt ?? entry.completedAt, state: "done" as const };
    if (entry.kind === "tool" && entry.state === "running") {
      return { ...entry, completedAt: completedAt ?? entry.completedAt, state: "stopped" as const };
    }
    if (entry.kind === "node" && entry.status === "running") {
      return {
        ...entry,
        completedAt: completedAt ?? entry.completedAt,
        status: "interrupted" as const,
      };
    }
    return entry;
  });
}

/** A Run's subagents still running when its attempt ended were stopped with it. */
function stopRunNodes(
  entries: readonly TranscriptEntry[],
  runId: string | null,
  at: string,
): TranscriptEntry[] {
  return entries.map((entry) =>
    entry.kind === "node" && entry.runId === runId && entry.status === "running"
      ? { ...entry, completedAt: at, status: "interrupted" as const }
      : entry,
  );
}

function nodeIdOf(...candidates: readonly (string | undefined)[]): { nodeId?: string } {
  const nodeId = candidates.find((candidate) => candidate !== undefined);
  return nodeId === undefined ? {} : { nodeId };
}

function nodeEntryId(nodeId: string): string {
  return `node:${nodeId}`;
}

export function isTerminalRunEntryStatus(status: RunEntry["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/**
 * What the conversation shows: every entry except the markers a withdrawn or
 * unloaded message left behind, and a message the Thread's queue still holds.
 * The queue read is the one authority on what is waiting, so in a work Thread
 * a message sent behind a running turn is drawn unsent from the queue, at the
 * conversation's foot, and joins the conversation only once a Run takes it.
 *
 * A conversation draws no queue. A person's own message that waits there for a
 * moment — its reply has not started, or waits on an approval — is what they
 * just said, so it is drawn as a sent bubble after everything else, in queue
 * order, until a Run takes it. Someone else's waiting input stays hidden, as
 * in a work Thread. A message a Run has already taken stays where the Run took
 * it, whatever a queue read that has not caught up says. Nothing to hide or
 * move hands back the same array, so readers keyed on identity stay put.
 */
export function visibleTranscript(
  entries: readonly TranscriptEntry[],
  queue: ThreadInputQueue | null,
  { conversation = false }: { readonly conversation?: boolean } = {},
): readonly TranscriptEntry[] {
  const order = new Map<string, number>(
    queue?.items.map((item, index) => [item.message.id, index]) ?? [],
  );
  const shown: TranscriptEntry[] = [];
  const waiting: MessageEntry[] = [];
  for (const entry of entries) {
    if (
      entry.kind === "selection" ||
      entry.kind === "withdrawn" ||
      entry.kind === "delivery" ||
      entry.kind === "request-wait"
    )
      continue;
    if (entry.kind !== "message" || !order.has(entry.id)) {
      shown.push(entry);
      continue;
    }
    if (!conversation || entry.author.kind !== "human") continue;
    if (entry.runId === null) waiting.push(entry);
    else shown.push(entry);
  }
  waiting.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const visible = [...shown, ...waiting];
  return visible.length === entries.length &&
    visible.every((entry, index) => entry === entries[index])
    ? entries
    : visible;
}

export function messageBody(content: ReadonlyArray<Record<string, unknown>>): string {
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

type TranscriptMessageKind = Extract<MessageKind, "assistant" | "input">;

/**
 * The entry a Message makes in the conversation, or null for one it does not
 * show. An assignment's return is the Host's structured source, never its
 * text: that is written for the model and names internal ids.
 */
export function toTranscriptEntry(
  message: MessageView,
  policy: ThreadInputPolicy | undefined = message.policy,
  input?: Pick<ThreadInput, "policy" | "state"> | null,
): AssignmentReturnEntry | MessageEntry | null {
  const assignmentId = assignmentReturnId(message);
  if (assignmentId === null) return toMessageEntry(message, policy, input);
  return {
    assignmentId,
    createdAt: message.createdAt,
    id: message.id,
    kind: "assignment-return",
    runId: message.runId,
    sequence: message.sequence,
  };
}

/** The assignment a platform return message reports, or null for any other message. */
export function assignmentReturnId(message: Pick<MessageView, "author">): string | null {
  const { author } = message;
  return author.kind === "platform" &&
    author.cause === "assignment-result" &&
    author.referenceId !== undefined
    ? author.referenceId
    : null;
}

/** Model-control messages remain durable and agent-readable but are not conversation UI. */
export function toMessageEntry(
  message: MessageView,
  policy: ThreadInputPolicy | undefined = message.policy,
  input?: Pick<ThreadInput, "policy" | "state"> | null,
): MessageEntry | null {
  const recovery =
    message.kind === "continuation" &&
    message.author.kind === "platform" &&
    message.author.cause === "run-recovery";
  const kind = isTranscriptMessageKind(message.kind)
    ? message.kind
    : recovery
      ? "continuation"
      : null;
  if (kind === null) return null;
  if (!contentSaysSomething(message.content)) return null;
  const body = messageBody(message.content);
  const attachments = message.content.filter((part) => part.type === "artifact");
  const pages = message.content.filter((part) => part.type === "browser-page");
  const places = message.content.filter(
    (part) => part.type === "computer-app" || part.type === "phone",
  );
  return {
    author: message.author,
    ...(message.addressedToUserId ? { addressedToUserId: message.addressedToUserId } : {}),
    sequence: message.sequence,
    published: input ? threadInputIsPublished(input) : (message.published ?? true),
    ...(message.quote ? { quote: message.quote } : {}),
    attachments,
    pages,
    ...(places.length ? { places } : {}),
    body,
    createdAt: message.createdAt,
    id: message.id,
    kind: "message",
    messageKind: kind,
    ...(message.kind === "input" && policy ? { policy } : {}),
    runId: message.runId,
  };
}

export function isTranscriptMessageKind(kind: MessageKind): kind is TranscriptMessageKind {
  return kind === "assistant" || kind === "input";
}

function upsertRunEntry(
  entries: readonly TranscriptEntry[],
  event: AgentEvent,
  status: RunEntryStatus,
  error: RunEntry["error"] = null,
  replyMessageId: string | null = null,
): TranscriptEntry[] {
  const id = event.runId ? `run:${event.runId}` : `event:${event.eventId}`;
  const prior = findEntry(entries, id, "run");
  const startedBy = "startedBy" in event.data ? event.data.startedBy : prior?.startedBy;
  return upsertEntry(entries, {
    ...runContext(prior, event),
    error: error ?? prior?.error ?? null,
    id,
    kind: "run",
    replyMessageId: replyMessageId ?? prior?.replyMessageId ?? null,
    runId: event.runId,
    status,
    // A Stop already asked for holds until the Run ends, whatever it reports meanwhile.
    ...(prior?.stopping === true && !isTerminalRunEntryStatus(status) ? { stopping: true } : {}),
    ...(prior?.usage ? { usage: prior.usage } : {}),
    ...(prior?.attempt ? { attempt: prior.attempt } : {}),
    ...(startedBy ? { startedBy } : {}),
    ...(prior?.background && !isTerminalRunEntryStatus(status) ? { background: true } : {}),
    ...(prior?.turnReplyMessageIds ? { turnReplyMessageIds: prior.turnReplyMessageIds } : {}),
    ...(prior?.priorUsage ? { priorUsage: prior.priorUsage } : {}),
    ...(isTerminalRunEntryStatus(status) ? { endedAt: event.createdAt } : {}),
  });
}

/** Two attempts' usage as one Run's: a count either attempt stated is summed. */
function addRunUsage(left: RunUsage, right: RunUsage): RunUsage {
  const optional = (
    key: "cachedInputTokens" | "cacheWriteTokens" | "costUsd" | "reasoningTokens",
  ) =>
    left[key] === undefined && right[key] === undefined
      ? {}
      : { [key]: (left[key] ?? 0) + (right[key] ?? 0) };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...optional("cachedInputTokens"),
    ...optional("cacheWriteTokens"),
    ...optional("costUsd"),
    ...optional("reasoningTokens"),
  };
}

type EntryOfKind<Kind extends TranscriptEntry["kind"]> = Extract<TranscriptEntry, { kind: Kind }>;

function findEntry<Kind extends TranscriptEntry["kind"]>(
  entries: readonly TranscriptEntry[],
  id: string,
  kind: Kind,
): EntryOfKind<Kind> | undefined {
  const entry = entries.find((item) => item.id === id);
  return entry && entry.kind === kind ? (entry as EntryOfKind<Kind>) : undefined;
}

export function upsertEntry(
  entries: readonly TranscriptEntry[],
  entry: TranscriptEntry,
): TranscriptEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index < 0) return [...entries, entry];
  return entries.map((item, itemIndex) => (itemIndex === index ? entry : item));
}

function replaceEntry(
  entries: readonly TranscriptEntry[],
  id: string,
  replacement: TranscriptEntry,
): TranscriptEntry[] {
  const withoutDuplicate = entries.filter((item) => item.id !== replacement.id || item.id === id);
  return withoutDuplicate.map((item) => (item.id === id ? replacement : item));
}

function streamMessageId(scope: string): string {
  return `stream:${scope}`;
}

function reasoningEntryId(runId: string | null, blockId: string): string {
  return `reasoning:${runId ?? "none"}:${blockId}`;
}

function toolEntryId(runId: string | null, callId: string): string {
  return `tool:${runId ?? "none"}:${callId}`;
}

/** The receipt a resolved Request leaves in its Thread, wherever it was resolved. */
export function requestReceipt(
  request: Extract<Request, { status: "declined" | "fulfilled" | "withdrawn" }>,
): RequestReceiptEntry {
  return {
    createdAt: request.resolvedAt,
    ...(request.status === "declined" ? { declined: true } : {}),
    id: `request:${request.id}`,
    kind: "request",
    outcome: requestOutcome(request),
    requestId: request.id,
    requestKind: request.kind,
    runId: request.originatingRunId,
    ...(request.kind === "browser.password-sign-in"
      ? { succeeded: passwordSignInOutcome(request)?.signedIn ?? false }
      : {}),
    title: requestTitleText(request.presentation),
    ...(request.mode === "live" ? { waitedSince: request.createdAt } : {}),
  };
}

function requestOutcome(request: Request): string {
  if (request.status === "pending") return "Pending";
  if (request.status === "cancelled") return `Cancelled · ${request.cancellationReason}`;
  if (request.status === "withdrawn") return "Withdrawn";
  if (request.kind === "browser.sign-in") return browserSignInReceipt(request);
  if (request.kind === "browser.password-sign-in") return passwordSignInReceipt(request);
  const prefix = request.status === "declined" ? "Declined" : "Fulfilled";
  if (request.response.kind === "choice" && request.presentation.kind === "choice") {
    const { options } = request.presentation;
    const optionId = request.response.optionId;
    const chosen = options.find((option) => option.id === optionId);
    // The one way a Request offered to decline it says nothing "Declined" does not.
    if (
      !chosen ||
      (request.status === "declined" && options.filter(requestOptionDeclines).length === 1)
    ) {
      return prefix;
    }
    return `${prefix} · ${chosen.label}`;
  }
  if (request.response.kind === "form") return `${prefix} · Answered`;
  if (request.response.kind === "external") {
    return externalDecisionLabel(request.response.value?.["decision"]) ?? prefix;
  }
  return prefix;
}

/** A sign-in receipt says what happened to the browser, in the card's own words. */
export function browserSignInReceipt(request: Request): string {
  if (request.status === "declined") return "Not allowed";
  const response = BrowserSignInRequestResponseSchema.safeParse(
    request.response?.kind === "external" ? request.response.value : null,
  );
  if (!response.success || response.data.outcome === "session-closed") return "Allowed";
  const site = request.payload.kind === "browser.sign-in" ? request.payload.site : null;
  return site ? `Signed in to ${browserSiteLabel(site)}` : "Signed in";
}

/**
 * The receipt of an externally resolved Request. Its response value carries the
 * decision, which is all the receipt says: a status beside it would repeat it.
 */
function externalDecisionLabel(decision: unknown): string | null {
  if (decision === "fulfilled") return "Allowed";
  return decision === "declined" ? "Declined" : null;
}

/** Bounds streamed accumulation for memory; final events carry authoritative text. */
function boundedStreamText(value: string): string {
  const maxLength = 120_000;
  if (value.length <= maxLength) return value;
  return `…${value.slice(value.length - (maxLength - 1))}`;
}

export type {
  AssignmentReturnEntry,
  DelegationEntry,
  DeliveryEntry,
  MessageEntry,
  ReasoningEntry,
  RequestReceiptEntry,
  RunEntry,
  ToolEntry,
};

function runContext(prior: RunEntry | undefined, event: AgentEvent) {
  const startedAt =
    ("startedAt" in event.data ? event.data.startedAt : undefined) ?? prior?.startedAt;
  return {
    createdAt: startedAt ?? prior?.createdAt ?? event.createdAt,
    ...(startedAt ? { startedAt } : {}),
    personWaiting:
      prior?.personWaiting === true ||
      ("personWaiting" in event.data && event.data.personWaiting === true),
  };
}
