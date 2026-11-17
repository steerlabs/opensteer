import type { TranscriptItem, TranscriptItemResult } from "@opensteer/protocol/transcript";
import type { MessageAuthor } from "@opensteer/core";
import type { NodeDetailEntry } from "./node-detail.js";
import type { TranscriptEntry, RunEntryStatus } from "./client.js";
import { executionNodeEntry } from "./subagent-model.js";
import { toMessageEntry } from "./transcript.js";

export function transcriptCard(
  item: TranscriptItem,
  body?: TranscriptItemResult["body"],
): TranscriptEntry | undefined {
  const { id, createdAt, runId, view } = item;
  const base = { id, createdAt, runId };
  const preview = view.preview ?? "";
  switch (item.kind) {
    case "message": {
      const full = body?.kind === "message" ? toMessageEntry(body.message) : undefined;
      if (full) return { ...full, itemId: id, itemRevision: item.revision };
      const messageKind =
        item.messageKind ??
        (view.author === "assistant" || !item.isTurnStart ? "assistant" : "input");
      const author: MessageAuthor = item.author ?? { kind: "platform", cause: "transcript" };
      return {
        ...base,
        id: item.messageId,
        itemId: id,
        itemRevision: item.revision,
        previewTruncated: view.truncated === true,
        kind: "message",
        author,
        messageKind,
        body: preview,
        published: view.published ?? true,
      };
    }
    case "tool": {
      const detail = body?.kind === "tool" ? body : undefined;
      const state =
        view.status === "running" || view.status === "failed" || view.status === "stopped"
          ? view.status
          : "done";
      return {
        ...base,
        kind: "tool",
        itemId: id,
        itemRevision: item.revision,
        callId: item.toolCallId,
        arguments: detail?.arguments,
        integration: null,
        isError: state === "failed",
        ...(item.nodeId ? { nodeId: item.nodeId } : {}),
        output: detail?.output,
        state,
        streamText: preview,
        tool: item.tool ?? null,
      };
    }
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        itemId: id,
        itemRevision: item.revision,
        previewTruncated: view.truncated === true,
        state: "done",
        text: body?.kind === "text" ? body.text : preview,
      };
    case "request":
      return view.status === "pending"
        ? { ...base, kind: "request-wait", requestId: item.requestId }
        : {
            ...base,
            kind: "request",
            requestId: item.requestId,
            requestKind: item.requestKind ?? null,
            title: view.title ?? "Request",
            outcome: preview,
          };
    case "run": {
      const status: RunEntryStatus =
        view.status === "completed" ||
        view.status === "failed" ||
        view.status === "interrupted" ||
        view.status === "queued" ||
        view.status === "starting" ||
        view.status === "waiting"
          ? view.status
          : "running";
      return {
        ...base,
        kind: "run",
        error: item.failure ?? null,
        replyMessageId: item.replyMessageId ?? null,
        ...(item.endedAt ? { endedAt: item.endedAt } : {}),
        ...(item.usage ? { usage: item.usage } : {}),
        status,
      };
    }
    case "node": {
      const node = body?.kind === "node" ? body.node : item.node;
      if (node) return executionNodeEntry(node);
      return {
        ...base,
        kind: "node",
        nodeId: item.executionNodeId,
        nodeKind: "subagent",
        completedAt: null,
        model: null,
        effort: null,
        phaseIndex: null,
        phases: [],
        progress: null,
        originCallId: null,
        parentNodeId: item.nodeId,
        prompt: null,
        result: preview || null,
        status:
          view.status === "completed" || view.status === "failed" || view.status === "interrupted"
            ? view.status
            : "running",
        title: view.title ?? "Subagent",
      };
    }
    case "place":
      return item.place && runId ? { ...base, ...item.place, runId, kind: "place" } : undefined;
    case "app":
      return runId
        ? { ...base, runId, kind: "app", appId: item.appId, title: view.title ?? "App", version: 0 }
        : undefined;
    case "delegation":
    case "assignment": {
      const assignment = body?.kind === "assignment" ? body.assignment : item.assignment;
      return assignment ? { ...base, kind: "assignment", assignment } : undefined;
    }
    default:
      return undefined;
  }
}

export function nodeTranscriptCard(item: TranscriptItem): NodeDetailEntry | undefined {
  if (item.kind === "node-message")
    return {
      kind: "node-message",
      id: item.id,
      createdAt: item.createdAt,
      text: item.view.preview ?? "",
      itemRevision: item.revision,
      previewTruncated: item.view.truncated === true,
    };
  const card = transcriptCard(item);
  if (card?.kind === "tool" || card?.kind === "reasoning" || card?.kind === "node") return card;
  return undefined;
}
