import { surrogateSafeCut, type AssignmentSummary, type Request } from "@opensteer/core";
import type { AssignmentEntry, HostSnapshot, NodeEntry, TranscriptEntry } from "./client.js";
import type { Turn, WorkEntry } from "./agent-activity-model.js";
import {
  assignmentPresentation,
  currentAssignment,
  type AssignmentReader,
} from "./assignment-presentation.js";

export type SubagentStatus = "working" | "waiting" | "done" | "failed" | "stopped";

export interface SubagentCard {
  readonly id: string;
  readonly origin: "node" | "assignment";
  readonly kind: "subagent" | "workflow";
  readonly open:
    | { readonly kind: "node-detail"; readonly threadId: string; readonly nodeId: string }
    | { readonly kind: "conversation"; readonly threadId: string; readonly workspaceId: string };
  readonly title: string;
  readonly status: SubagentStatus;
  readonly statusLabel: string;
  readonly line: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly runId: string | null;
  readonly waitingOnPerson: boolean;
  readonly parentNodeId: string | null;
  readonly phaseIndex: number | null;
  readonly phases: readonly SubagentPhase[];
  readonly unphasedMembers: readonly SubagentCard[];
}

export interface SubagentPhase {
  readonly index: number;
  readonly title: string;
  readonly members: readonly SubagentCard[];
  readonly settled: number;
  readonly total: number;
  readonly status: "pending" | "working" | "done";
}

export interface SubagentGroup {
  readonly kind: "subagents";
  readonly key: string;
  readonly cards: readonly SubagentCard[];
  readonly summary: string;
  readonly counts: SubagentCounts;
}

export type SubagentCounts = Readonly<Record<SubagentStatus, number>> & {
  readonly total: number;
  readonly active: number;
};
export interface SubagentRoster {
  readonly cards: readonly SubagentCard[];
  readonly counts: SubagentCounts;
  readonly pill: { readonly label: string; readonly accessibilityLabel: string } | null;
}

const statusLabels: Record<SubagentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

// Title normalization and preview behavior adapted from T3 Code (MIT).
export function subagentTitle(title: string): string {
  const display = title.replace(/^Subagent:\s*/iu, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(display);
  if (!path) return display;
  return (
    path[1]!
      .replace(/[_\s]+/gu, " ")
      .trim()
      .replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || display
  );
}

export function subagentPreview(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/gu, " ").trim();
  if (!compact) return null;
  return compact.length > 280
    ? `${compact.slice(0, surrogateSafeCut(compact, 280)).trimEnd()}…`
    : compact;
}

export function isActiveSubagent(card: Pick<SubagentCard, "status">): boolean {
  return card.status === "working" || card.status === "waiting";
}

export function subagentCounts(cards: readonly Pick<SubagentCard, "status">[]): SubagentCounts {
  const counts = { working: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };
  for (const card of cards) counts[card.status] += 1;
  return { ...counts, active: counts.working + counts.waiting, total: cards.length };
}

export function subagentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"}`;
}

export function subagentGroup(cards: readonly SubagentCard[]): SubagentGroup {
  const counts = subagentCounts(cards);
  const statuses: readonly SubagentStatus[] = ["working", "waiting", "done", "failed", "stopped"];
  return {
    kind: "subagents",
    key: `subagents:${cards[0]?.id ?? "empty"}`,
    cards,
    counts,
    summary: [
      subagentCountLabel(counts.total),
      ...statuses
        .filter((status) => counts[status] > 0)
        .map((status) => `${counts[status]} ${status}`),
    ].join(" · "),
  };
}

export function nodeSubagentCard(
  node: NodeEntry,
  threadId: string,
  nodes: readonly NodeEntry[] = [],
  requests: readonly Request[] = [],
): SubagentCard | null {
  if (node.nodeKind === "task") return null;
  const waiting =
    node.status === "running" &&
    requests.some(
      (request) => request.status === "pending" && request.originatingNodeId === node.nodeId,
    );
  const status: SubagentStatus = waiting
    ? "waiting"
    : node.status === "running"
      ? "working"
      : node.status === "completed"
        ? "done"
        : node.status === "failed"
          ? "failed"
          : "stopped";
  const phaseIndices = new Set(node.phases.map((_, index) => index));
  const members =
    node.nodeKind === "workflow"
      ? nodes.filter(
          (member) =>
            member.parentNodeId === node.nodeId &&
            member.nodeId !== node.nodeId &&
            member.nodeKind !== "task",
        )
      : [];
  for (const member of members) if (member.phaseIndex !== null) phaseIndices.add(member.phaseIndex);
  const cards = members.flatMap((member) => {
    const card = nodeSubagentCard(member, threadId, [], requests);
    return card ? [card] : [];
  });
  const phases = [...phaseIndices]
    .sort((a, b) => a - b)
    .map((index): SubagentPhase => {
      const group = cards.filter((member) => member.phaseIndex === index);
      const settled = group.filter((member) => !isActiveSubagent(member)).length;
      return {
        index,
        title: node.phases[index] ?? `Phase ${index + 1}`,
        members: group,
        settled,
        total: group.length,
        status: group.length === 0 ? "pending" : settled === group.length ? "done" : "working",
      };
    });
  return {
    id: node.id,
    origin: "node",
    kind: node.nodeKind,
    open: { kind: "node-detail", threadId, nodeId: node.nodeId },
    title: subagentTitle(node.title),
    status,
    statusLabel: statusLabels[status],
    line: subagentPreview(isActiveSubagent({ status }) ? node.progress : node.result),
    model: node.model,
    effort: node.effort,
    modelLabel: node.model?.trim() || "Not reported",
    effortLabel: node.effort?.trim() || null,
    startedAt: node.createdAt,
    endedAt: node.completedAt,
    runId: node.runId,
    waitingOnPerson: waiting,
    parentNodeId: node.parentNodeId,
    phaseIndex: node.phaseIndex,
    phases,
    unphasedMembers: cards.filter((member) => member.phaseIndex === null),
  };
}

export function assignmentSubagentCard(
  assignment: AssignmentSummary,
  reader: AssignmentReader,
): SubagentCard {
  const presentation = assignmentPresentation(assignment, reader);
  const waiting =
    presentation.tone === "waiting" ||
    assignment.currentRunStatus === "waiting" ||
    assignment.workerThread.pendingRequests > 0;
  const status: SubagentStatus =
    assignment.status === "completed"
      ? "done"
      : assignment.status === "failed"
        ? "failed"
        : assignment.status === "cancelled" || assignment.currentRunStatus === "interrupted"
          ? "stopped"
          : waiting
            ? "waiting"
            : "working";
  return {
    id: `assignment:${assignment.id}`,
    origin: "assignment",
    kind: "subagent",
    open: {
      kind: "conversation",
      threadId: assignment.workerThread.id,
      workspaceId: assignment.workerThread.workspaceId,
    },
    title: subagentTitle(
      reader.threads.find(({ id }) => id === assignment.workerThread.id)?.title ??
        assignment.workerThread.title,
    ),
    status,
    statusLabel: statusLabels[status],
    line: subagentPreview(
      assignment.status === "open" ? presentation.detail?.text : assignment.resultPreview,
    ),
    model: assignment.modelLabel,
    effort: null,
    modelLabel: assignment.modelLabel || "Not reported",
    effortLabel: null,
    startedAt: assignment.createdAt,
    endedAt: assignment.finishedAt,
    runId: assignment.initialRunId,
    waitingOnPerson: waiting && assignment.status === "open",
    parentNodeId: null,
    phaseIndex: null,
    phases: [],
    unphasedMembers: [],
  };
}

export type SubagentReader = AssignmentReader & Pick<HostSnapshot, "assignments">;

export function conversationSubagents(reader: SubagentReader, threadId: string): SubagentRoster {
  const nodes = (reader.transcripts[threadId] ?? []).filter(
    (entry): entry is NodeEntry => entry.kind === "node",
  );
  const workflowIds = new Set(
    nodes.filter((node) => node.nodeKind === "workflow").map((node) => node.nodeId),
  );
  const requests = Object.values(reader.requests).flat();
  const cards = nodes
    .filter((node) => !node.parentNodeId || !workflowIds.has(node.parentNodeId))
    .flatMap((node) => {
      const card = nodeSubagentCard(node, threadId, nodes, requests);
      return card ? [card] : [];
    });
  const assignments = new Map(Object.entries(reader.assignments));
  for (const entry of reader.transcripts[threadId] ?? [])
    if (entry.kind === "assignment")
      assignments.set(entry.assignment.id, currentAssignment(entry, reader.assignments));
  for (const assignment of assignments.values())
    if (assignment.origin === "run" && assignment.parentThreadId === threadId)
      cards.push(assignmentSubagentCard(assignment, reader));
  cards.sort(
    (a, b) =>
      Number(isActiveSubagent(b)) - Number(isActiveSubagent(a)) ||
      (isActiveSubagent(a)
        ? a.startedAt.localeCompare(b.startedAt)
        : (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt)) ||
      a.id.localeCompare(b.id),
  );
  const counts = subagentCounts(cards);
  return {
    cards,
    counts,
    pill:
      cards.length === 0
        ? null
        : {
            label: `${counts.active}/${counts.total} agents`,
            accessibilityLabel: `${counts.active} of ${counts.total} agents working or waiting`,
          },
  };
}

export type SubagentTurnRow = { readonly kind: "work"; readonly entry: WorkEntry } | SubagentGroup;

/** Adjacent helpers share a card group; a workflow carries its members only inside its phases. */
export function subagentTurnModel(
  turn: Turn,
  threadId: string,
  reader: SubagentReader,
): {
  readonly rows: readonly SubagentTurnRow[];
  readonly outsideFold: readonly SubagentGroup[];
  readonly helperCount: number;
} {
  const nodes = (reader.transcripts[threadId] ?? []).filter(
    (entry): entry is NodeEntry => entry.kind === "node",
  );
  const requests = Object.values(reader.requests).flat();
  const items: (WorkEntry | AssignmentEntry)[] = [...turn.work, ...turn.assignments];
  const positions = new Map(
    (reader.transcripts[threadId] ?? []).map((entry, index) => [entry.id, index]),
  );
  items.sort((a, b) => {
    const left = positions.get(a.id);
    const right = positions.get(b.id);
    return left !== undefined && right !== undefined
      ? left - right
      : a.createdAt.localeCompare(b.createdAt);
  });
  const rows: SubagentTurnRow[] = [];
  let pending: SubagentCard[] = [];
  const flush = () => {
    if (pending.length) {
      rows.push(subagentGroup(pending));
      pending = [];
    }
  };
  let helperCount = 0;
  for (const entry of items) {
    const card =
      entry.kind === "node"
        ? nodeSubagentCard(entry, threadId, nodes, requests)
        : entry.kind === "assignment"
          ? assignmentSubagentCard(currentAssignment(entry, reader.assignments), reader)
          : null;
    if (card) {
      pending.push(card);
      helperCount += 1;
    } else {
      flush();
      if (entry.kind !== "assignment") rows.push({ kind: "work", entry });
    }
  }
  flush();
  const active = rows.flatMap((row) =>
    row.kind === "subagents" ? row.cards.filter(isActiveSubagent) : [],
  );
  return { rows, helperCount, outsideFold: active.length ? [subagentGroup(active)] : [] };
}

export function foldedSubagentSummary(label: string, count: number): string {
  return count > 0 ? `${label} · ${subagentCountLabel(count)}` : label;
}

export function transcriptNodes(entries: readonly TranscriptEntry[]): readonly NodeEntry[] {
  return entries.filter((entry): entry is NodeEntry => entry.kind === "node");
}

export function executionNodeEntry(node: import("@opensteer/core").ExecutionNode): NodeEntry {
  return {
    id: `node:${node.id}`,
    kind: "node",
    nodeId: node.id,
    nodeKind: node.kind,
    createdAt: node.startedAt,
    completedAt: node.endedAt,
    model: node.model,
    effort: node.effort,
    parentNodeId: node.parentNodeId,
    phaseIndex: node.phaseIndex,
    phases: node.phases,
    progress: null,
    originCallId: null,
    prompt: node.prompt,
    result: node.result,
    runId: node.runId,
    status: node.status,
    title: node.title,
    ...(node.usage ? { usage: node.usage } : {}),
  };
}
