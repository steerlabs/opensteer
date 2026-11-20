import type { TranscriptItem, TranscriptItemResult } from "@opensteer/protocol/transcript";
import type { MessageAuthor } from "@opensteer/core";
import type { NodeDetailEntry } from "./node-detail.js";
import type { MessageEntry, TranscriptEntry, RunEntryStatus } from "./client.js";
import { executionNodeEntry } from "./subagent-model.js";
import { hydrateTranscriptMessage } from "./transcript.js";

export function transcriptCard(
  item: TranscriptItem,
  body?: TranscriptItemResult["body"],
  live = false,
): TranscriptEntry | undefined {
  const { id, createdAt, runId, view } = item;
  const base = { id, createdAt, runId };
  const preview = view.preview ?? "";
  switch (item.kind) {
    case "message": {
      const messageKind =
        item.messageKind ??
        (view.author === "assistant" || !item.isTurnStart ? "assistant" : "input");
      const author: MessageAuthor = item.author ?? { kind: "platform", cause: "transcript" };
      const message: MessageEntry = {
        ...base,
        id: item.messageId,
        ...(item.clientSendKey ? { clientSendKey: item.clientSendKey } : {}),
        itemId: id,
        itemRevision: item.revision,
        previewTruncated: view.truncated === true,
        ...(live ? { streaming: true } : {}),
        kind: "message",
        author,
        ...(item.edit ? { edit: item.edit } : {}),
        ...(item.teamSource ? { teamSource: item.teamSource } : {}),
        ...(item.delivery ? { delivery: item.delivery } : {}),
        messageKind,
        body: item.text ?? preview,
        published: view.published ?? true,
        ...(item.attachments ? { attachments: item.attachments } : {}),
        ...(item.pages ? { pages: item.pages } : {}),
        ...(item.places ? { places: item.places } : {}),
      };
      return body?.kind === "message"
        ? (hydrateTranscriptMessage(message, body.message) ?? undefined)
        : message;
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
        integration: detail?.integration ?? null,
        isError: state === "failed",
        ...(item.nodeId ? { nodeId: item.nodeId } : {}),
        output: detail?.output,
        state,
        streamText: preview,
        ...(item.completedAt ? { completedAt: item.completedAt } : {}),
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
        state: live ? "streaming" : "done",
        text: body?.kind === "text" ? body.text : preview,
      };
    case "request":
      return view.status === "pending"
        ? { ...base, kind: "request-wait", requestId: item.requestId }
        : {
            ...base,
            kind: "request",
            ...(view.status === "declined" ? { declined: true } : {}),
            requestId: item.requestId,
            requestKind: item.requestKind ?? null,
            title: view.title ?? "Request",
            outcome: preview,
            ...(item.question ? { question: item.question } : {}),
            ...(item.waitedSince ? { waitedSince: item.waitedSince } : {}),
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
        ...(item.delivery ? { delivery: item.delivery } : {}),
        ...(view.status === "background" ? { background: true } : {}),
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
        ? {
            ...base,
            runId,
            kind: "app",
            appId: item.appId,
            title: view.title ?? "App",
            version: item.version ?? 0,
          }
        : undefined;
    case "assignment": {
      const assignment = body?.kind === "assignment" ? body.assignment : item.assignment;
      return assignment ? { ...base, kind: "assignment", assignment } : undefined;
    }
    default:
      return undefined;
  }
}

export function nodeTranscriptCard(
  item: TranscriptItem,
  live = false,
): NodeDetailEntry | undefined {
  if (item.kind === "node-message")
    return {
      kind: "node-message",
      id: item.id,
      createdAt: item.createdAt,
      text: item.text ?? item.view.preview ?? "",
      itemRevision: item.revision,
      previewTruncated: item.view.truncated === true,
    };
  const card = transcriptCard(item, undefined, live);
  if (card?.kind === "tool" || card?.kind === "reasoning" || card?.kind === "node") return card;
  return undefined;
}
