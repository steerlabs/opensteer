import {
  nodeSubagentCard,
  type AgentCard,
  type SubagentReader,
  transcriptNodes,
} from "./subagent-model.js";
import type { NodeEntry, ReasoningEntry, ToolEntry } from "./client.js";
import { subagentLineage } from "./subagent-now.js";

export interface NodeMessageEntry {
  readonly kind: "node-message";
  readonly id: string;
  readonly createdAt: string;
  readonly itemRevision?: string;
  readonly previewTruncated?: boolean;
  readonly text: string;
}

export interface NodeResultEntry {
  readonly kind: "node-result";
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
}

export type NodeDetailEntry =
  NodeMessageEntry | NodeResultEntry | ReasoningEntry | ToolEntry | NodeEntry;

export interface NodeDetailSnapshot {
  readonly nodeId: string;
  readonly threadId: string;
  readonly node: NodeEntry | null;
  readonly status: "unavailable" | "loading" | "ready" | "error" | "missing" | "closed";
  readonly entries: readonly NodeDetailEntry[];
  readonly generation?: number;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | null;
}

/**
 * Hold while the read-only transcript is visible. Two holders of the same
 * subagent share one watch and what it has loaded; another subagent's watch
 * replaces it.
 */
export interface NodeDetailSubscription {
  getSnapshot(): NodeDetailSnapshot;
  subscribe(listener: () => void): () => void;
  loadOlder(): Promise<void>;
  retry(): void;
  release(): void;
}

export type SubagentDetailEntry =
  | (Omit<NodeMessageEntry, "kind"> & { readonly kind: "message" })
  | ReasoningEntry
  | ToolEntry
  | { readonly kind: "agent"; readonly card: AgentCard };
export interface SubagentDetail {
  readonly generation?: number | undefined;
  readonly state: "loading" | "ready" | "summary-only" | "error" | "unavailable" | "missing";
  readonly card: AgentCard;
  readonly prompt: string | null;
  readonly parent: { readonly threadId: string; readonly title: string; readonly nodeId?: string };
  /** The subagents above it, outermost first; empty when the conversation started it. */
  readonly lineage: readonly { readonly nodeId: string; readonly title: string }[];
  readonly entries: readonly SubagentDetailEntry[];
  readonly result: string | null;
  readonly hasEarlier: boolean;
  readonly loadingEarlier: boolean;
}
export function subagentDetail(
  snapshot: NodeDetailSnapshot,
  summary: NodeEntry,
  reader: SubagentReader,
): SubagentDetail {
  const node = snapshot.node ?? summary;
  const nodes = [
    ...new Map(
      [
        ...transcriptNodes(reader.transcripts?.[snapshot.threadId] ?? []),
        ...snapshot.entries.filter((entry): entry is NodeEntry => entry.kind === "node"),
      ].map((entry) => [entry.nodeId, entry]),
    ).values(),
  ];
  const card = nodeSubagentCard(node, snapshot.threadId, nodes, reader);
  if (!card) throw new Error("Background tasks do not have subagent views.");
  const parentNode = nodes.find((candidate) => candidate.nodeId === node.parentNodeId);
  const entries: SubagentDetailEntry[] = snapshot.entries.flatMap(
    (entry): SubagentDetailEntry[] => {
      switch (entry.kind) {
        case "node-message":
          return [{ ...entry, kind: "message" }];
        case "reasoning":
          return [entry];
        case "tool":
          return [entry];
        case "node": {
          if (node.nodeKind === "workflow") return [];
          const child = nodeSubagentCard(entry, snapshot.threadId, nodes, reader);
          return child ? [{ kind: "agent", card: child }] : [];
        }
        case "node-result":
          return [];
      }
    },
  );
  const lastMessage = entries.findLast((entry) => entry.kind === "message");
  const result =
    lastMessage?.kind === "message" && lastMessage.text === node.result ? null : node.result;
  const state =
    snapshot.status === "closed"
      ? "missing"
      : snapshot.status === "ready" &&
          node.status !== "running" &&
          !snapshot.hasMore &&
          !entries.some((entry) => entry.kind !== "agent")
        ? "summary-only"
        : snapshot.status;
  return {
    generation: snapshot.generation,
    state,
    card,
    prompt: node.prompt,
    parent: {
      threadId: snapshot.threadId,
      title:
        parentNode?.title ??
        reader.threads.find((thread) => thread.id === snapshot.threadId)?.title ??
        "Parent conversation",
      ...(parentNode ? { nodeId: parentNode.nodeId } : {}),
    },
    lineage: subagentLineage(nodes, node.nodeId),
    entries,
    result,
    hasEarlier: snapshot.hasMore,
    loadingEarlier: snapshot.loadingOlder,
  };
}
