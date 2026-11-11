import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { requestTitleText, type AssignmentSummary, type ExecutionNodeView } from "@opensteer/core";
import type { AssignmentEntry, HostSnapshot, NodeEntry, TranscriptEntry } from "./client.js";
import { workSummary, type Turn, type WorkEntry } from "./agent-activity-model.js";
import {
  assignmentPresentation,
  assignmentMark,
  currentAssignment,
  type AssignmentReader,
} from "./assignment-presentation.js";
import type { TaskMark } from "./task-marks.js";
import type { FamilyTask } from "./task-family.js";
import { catalogModelDisplayName } from "./model-catalog.js";
import { requestWaitingOnAssignment } from "./waiting-requests.js";

export type AgentTone = "working" | "needs-you" | "waiting" | "finished" | "failed" | "stopped";
export interface AgentCard {
  readonly stop?: { readonly threadId: string; readonly nodeId: string } | null;
  readonly key: string;
  readonly origin: "subagent" | "task";
  readonly kind: "subagent" | "workflow";
  readonly title: string;
  readonly tone: AgentTone;
  readonly word: string;
  readonly moving: boolean;
  readonly line: {
    readonly kind: "progress" | "question" | "result" | "error" | "prompt";
    readonly text: string;
  } | null;
  readonly modelLabel: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly opens:
    | { readonly kind: "subagent"; readonly threadId: string; readonly nodeId: string }
    | { readonly kind: "thread"; readonly threadId: string }
    | null;
  readonly requestId: string | null;
  readonly announcement: string;
  readonly workflow: WorkflowView | null;
  readonly task: {
    readonly assignmentId: string;
    readonly mark: TaskMark;
    readonly menu: true;
  } | null;
}
export interface WorkflowView {
  readonly phases: readonly {
    readonly index: number;
    readonly title: string;
    readonly settled: number;
    readonly total: number;
    readonly word: string;
    readonly tone: AgentTone | "pending";
    readonly members: readonly AgentCard[];
  }[];
  readonly openPhase: number | null;
  readonly summary: string;
}
export interface AgentGroup {
  readonly key: string;
  readonly noun: "subagent" | "task";
  readonly cards: readonly AgentCard[];
  readonly summary: string;
  readonly live: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
export interface AgentRoster {
  readonly now: readonly AgentCard[];
  readonly earlier: readonly AgentCard[];
  readonly pill: {
    readonly live: number;
    readonly total: number;
    readonly needsYou: number;
  } | null;
}
export type SubagentReader = AssignmentReader & Pick<HostSnapshot, "assignments">;
const words: Record<AgentTone, string> = {
  working: "Working",
  "needs-you": "Needs you",
  waiting: "Waiting",
  finished: "Finished",
  failed: "Couldn't finish",
  stopped: "Stopped",
};

// Title normalization adapted from T3 Code (MIT).
export function subagentTitle(title: string): string {
  const display = title.replace(/^Subagent:\s*/iu, "").trim();
  if (!display.includes("/") || /\s/u.test(display)) return display;
  return (display.replace(/\/+$/u, "").split("/").at(-1) ?? display)
    .replace(/[_-]+/gu, " ")
    .replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase());
}
export function subagentPreview(text: string | null | undefined): string | null {
  const compact = (
    text ? plainTextExcerpt(text.replace(/<[^>]*>/gu, ""), Number.MAX_SAFE_INTEGER) : null
  )?.replace(/(?<!\w)(\*|__|_)(?=\S)([^\n]*?\S)\1(?!\w)/gu, "$2");
  if (!compact) return null;
  const chars = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(compact),
  ].map((part) => part.segment);
  return chars.length > 280 ? chars.slice(0, 279).join("").trimEnd() + "…" : compact;
}
export function isActiveSubagent(card: Pick<AgentCard, "tone">): boolean {
  return card.tone === "working" || card.tone === "waiting" || card.tone === "needs-you";
}
function countLabel(count: number, noun: "subagent" | "task"): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
export function subagentGroup(cards: readonly AgentCard[]): AgentGroup {
  const first = cards[0];
  if (!first) throw new Error("An agent group needs a card.");
  const noun = first.origin;
  if (cards.some((card) => card.origin !== noun))
    throw new Error("Tasks and subagents need separate groups.");
  const counts = { working: 0, "needs-you": 0, finished: 0, failed: 0, stopped: 0 };
  for (const card of cards) counts[card.tone === "waiting" ? "working" : card.tone]++;
  const live = cards.some(isActiveSubagent);
  return {
    key: first.key,
    noun,
    cards,
    live,
    startedAt: cards.map((card) => card.startedAt).sort()[0]!,
    endedAt: live
      ? null
      : cards
          .map((card) => card.endedAt ?? card.startedAt)
          .sort()
          .at(-1)!,
    summary: [
      countLabel(cards.length, noun),
      ...(counts["needs-you"]
        ? [`${counts["needs-you"]} ${counts["needs-you"] === 1 ? "needs" : "need"} you`]
        : []),
      ...(["working", "finished", "failed", "stopped"] as const).flatMap((tone) =>
        counts[tone] ? [`${counts[tone]} ${tone}`] : [],
      ),
    ].join(" · "),
  };
}
function previewLine(
  kind: NonNullable<AgentCard["line"]>["kind"],
  value: string | null | undefined,
): AgentCard["line"] {
  const text = subagentPreview(value);
  return text ? { kind, text } : null;
}
export function nodeSubagentCard(
  node: NodeEntry,
  threadId: string,
  nodes: readonly NodeEntry[] = [],
  reader?: SubagentReader,
): AgentCard | null {
  if (node.nodeKind === "task") return null;
  const pending = Object.values(reader?.requests ?? {})
    .flat()
    .find((request) => request.status === "pending" && request.originatingNodeId === node.nodeId);
  const answerable = reader?.waitingRequests.find(
    ({ request }) => request.status === "pending" && request.originatingNodeId === node.nodeId,
  )?.request;
  const request = answerable ?? pending;
  const tone: AgentTone =
    node.status === "running"
      ? answerable
        ? "needs-you"
        : pending
          ? "waiting"
          : "working"
      : node.status === "completed"
        ? "finished"
        : node.status === "failed"
          ? "failed"
          : "stopped";
  const live = !reader || (reader.connection !== "offline" && reader.network !== "offline");
  const title = subagentTitle(node.title);
  const model =
    node.model && reader ? catalogModelDisplayName(node.model, reader.environments) : null;
  const workflow =
    node.nodeKind === "workflow" ? workflowView(node, threadId, nodes, reader) : null;
  const line =
    tone === "needs-you" && request
      ? previewLine("question", requestTitleText(request.presentation))
      : workflow
        ? previewLine("progress", workflow.summary)
        : tone === "finished"
          ? previewLine("result", node.result)
          : tone === "failed"
            ? (previewLine("error", node.result) ??
              previewLine("prompt", node.prompt?.split("\n")[0]))
            : tone === "stopped"
              ? (previewLine("result", node.result) ??
                previewLine("prompt", node.prompt?.split("\n")[0]))
              : (previewLine("progress", node.progress) ??
                previewLine("prompt", node.prompt?.split("\n")[0]));
  return {
    stop:
      live && node.status === "running" && node.stopSupported && !node.stopping
        ? { threadId, nodeId: node.nodeId }
        : null,
    key: `node:${node.nodeId}`,
    origin: "subagent",
    kind: node.nodeKind,
    title,
    tone,
    word: `${!live && isActiveSubagent({ tone }) ? "Last known: " : ""}${node.status === "running" && node.stopping ? "Stopping" : words[tone]}`,
    moving: live && tone === "working" && !node.stopping,
    line,
    modelLabel: model
      ? `${model}${node.effort ? ` · ${node.effort[0]!.toUpperCase()}${node.effort.slice(1)}` : ""}`
      : null,
    startedAt: node.createdAt,
    endedAt: node.completedAt,
    opens: { kind: "subagent", threadId, nodeId: node.nodeId },
    requestId: tone === "needs-you" ? (answerable?.id ?? null) : null,
    announcement: `${title} ${node.status === "running" && node.stopping ? "is stopping" : tone === "working" ? "is working" : words[tone].toLowerCase()}`,
    workflow,
    task: null,
  };
}
function workflowView(
  node: NodeEntry,
  threadId: string,
  nodes: readonly NodeEntry[],
  reader?: SubagentReader,
): WorkflowView {
  const children = nodes.filter(
    (member) =>
      member.parentNodeId === node.nodeId &&
      member.nodeKind !== "task" &&
      member.nodeId !== node.nodeId,
  );
  const indices = new Set(node.phases.map((_, index) => index));
  for (const child of children) indices.add(child.phaseIndex ?? 0);
  const phases = [...indices]
    .sort((a, b) => a - b)
    .map((index) => {
      const members = children
        .filter((child) => (child.phaseIndex ?? 0) === index)
        .flatMap((child) => {
          const card = nodeSubagentCard(child, threadId, [], reader);
          return card ? [card] : [];
        });
      const settled = members.filter((card) => !isActiveSubagent(card)).length;
      const failed = members.filter((card) => card.tone === "failed").length;
      const tone = members.some((card) => card.tone === "needs-you")
        ? "needs-you"
        : failed
          ? "failed"
          : members.some(isActiveSubagent)
            ? "working"
            : members.length
              ? "finished"
              : "pending";
      return {
        index,
        title: node.phases[index] ?? `Phase ${index + 1}`,
        members,
        settled,
        total: members.length,
        tone,
        word:
          tone === "pending" ? "Not started" : tone === "failed" ? `${failed} failed` : words[tone],
      } as const;
    });
  const openPhase =
    phases.find((phase) => phase.members.some(isActiveSubagent))?.index ??
    phases.find((phase) => phase.tone === "failed")?.index ??
    phases.findLast((phase) => phase.total > 0)?.index ??
    null;
  const current = phases.find((phase) => phase.index === openPhase);
  const settled =
    node.status !== "running" ||
    (phases.length > 0 &&
      phases.every((phase) => phase.total > 0 && phase.total === phase.settled));
  const summary = settled
    ? `${phases.length} phases · ${phases.reduce((n, phase) => n + phase.total, 0)} subagents`
    : current
      ? `Phase ${current.index + 1} of ${phases.length} · ${current.title} · ${current.settled} of ${current.total} finished`
      : `${phases.length} phases · 0 subagents`;
  return { phases, openPhase, summary };
}
export function assignmentSubagentCard(
  assignment: AssignmentSummary,
  reader: AssignmentReader,
): AgentCard {
  const presentation = assignmentPresentation(assignment, reader);
  const tones = {
    completed: "finished",
    failed: "failed",
    paused: "stopped",
    queued: "waiting",
    stopped: "stopped",
    waiting: "needs-you",
    working: "working",
  } as const;
  const tone = tones[presentation.tone];
  const request = requestWaitingOnAssignment(reader.waitingRequests, assignment.id)?.request;
  return {
    key: `task:${assignment.id}`,
    origin: "task",
    kind: "subagent",
    title: subagentTitle(
      reader.threads.find((thread) => thread.id === assignment.workerThread.id)?.title ??
        assignment.workerThread.title,
    ),
    tone,
    word: presentation.word,
    moving: presentation.moving,
    line: presentation.detail
      ? previewLine(
          presentation.detail.kind === "decision" ? "question" : "progress",
          presentation.detail.text,
        )
      : previewLine(
          assignment.status === "failed"
            ? "error"
            : assignment.status === "open"
              ? "prompt"
              : "result",
          assignment.status === "open" ? assignment.objectivePreview : assignment.resultPreview,
        ),
    modelLabel: presentation.model || null,
    startedAt: assignment.createdAt,
    endedAt: assignment.finishedAt,
    opens: { kind: "thread", threadId: assignment.workerThread.id },
    requestId: tone === "needs-you" ? (request?.id ?? null) : null,
    announcement: presentation.announcement,
    workflow: null,
    task: { assignmentId: assignment.id, mark: assignmentMark(assignment, reader), menu: true },
  };
}
/** `tasks: false` leaves delegated tasks to a surface that lists them on their own. */
export function conversationSubagents(
  reader: SubagentReader,
  threadId: string,
  { tasks = true }: { readonly tasks?: boolean } = {},
): AgentRoster {
  const entries = reader.transcripts[threadId] ?? [];
  const nodes = transcriptNodes(entries);
  const workflows = new Set(
    nodes.filter((node) => node.nodeKind === "workflow").map((node) => node.nodeId),
  );
  // A workflow's members are listed inside its row, never again beside it.
  const cards = nodes.flatMap((node) => {
    if (node.parentNodeId && workflows.has(node.parentNodeId)) return [];
    const card = nodeSubagentCard(node, threadId, nodes, reader);
    return card ? [card] : [];
  });
  const assignments = new Map(tasks ? Object.entries(reader.assignments) : []);
  for (const entry of entries)
    if (tasks && entry.kind === "assignment")
      assignments.set(entry.assignment.id, currentAssignment(entry, reader.assignments));
  for (const assignment of assignments.values())
    if (assignment.origin === "run" && assignment.parentThreadId === threadId)
      cards.push(assignmentSubagentCard(assignment, reader));
  const now = cards
    .filter(isActiveSubagent)
    .sort(
      (a, b) =>
        Number(b.tone === "needs-you") - Number(a.tone === "needs-you") ||
        a.startedAt.localeCompare(b.startedAt),
    );
  const earlier = cards
    .filter((card) => !isActiveSubagent(card))
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  return {
    now,
    earlier,
    pill: now.length
      ? {
          live: now.length,
          total: cards.length,
          needsYou: now.filter((card) => card.tone === "needs-you").length,
        }
      : null,
  };
}
export type EarlierHelper =
  | { readonly kind: "agent"; readonly card: AgentCard }
  | { readonly kind: "task"; readonly task: FamilyTask };
/** Settled subagents and settled tasks as one list, newest end first. */
export function earlierHelpers(
  cards: readonly AgentCard[],
  tasks: readonly FamilyTask[],
): readonly EarlierHelper[] {
  return [
    ...cards.map(
      (card) => ({ at: card.endedAt ?? card.startedAt, item: { kind: "agent", card } }) as const,
    ),
    ...tasks.map((task) => ({ at: task.finishedAt ?? "", item: { kind: "task", task } }) as const),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ item }) => item);
}
export type SubagentTurnRow =
  | { readonly kind: "work"; readonly entry: WorkEntry }
  | { readonly kind: "agents"; readonly group: AgentGroup }
  | { readonly kind: "workflow"; readonly card: AgentCard };
export interface TurnAgents {
  readonly groups: readonly AgentGroup[];
  readonly keptOutside: AgentGroup | null;
  readonly foldLabel: string | null;
  readonly rows: readonly SubagentTurnRow[];
  readonly keptKeys: readonly string[];
  readonly keptTasks: AgentGroup | null;
}
export function subagentTurnModel(
  turn: Turn,
  threadId: string,
  reader: SubagentReader,
  fold: { readonly folded: boolean; readonly keptKeys: readonly string[] } = {
    folded: false,
    keptKeys: [],
  },
): TurnAgents {
  const nodes = transcriptNodes(reader.transcripts[threadId] ?? []);
  const rows: SubagentTurnRow[] = [];
  let pending: AgentCard[] = [];
  const flush = () => {
    if (pending.length) {
      rows.push({ kind: "agents", group: subagentGroup(pending) });
      pending = [];
    }
  };
  const items: (WorkEntry | AssignmentEntry)[] = [...turn.work, ...turn.assignments];
  for (const entry of items) {
    if (entry.kind === "node" && entry.nodeKind !== "task" && entry.parentNodeId) continue;
    const card =
      entry.kind === "node"
        ? nodeSubagentCard(entry, threadId, nodes, reader)
        : entry.kind === "assignment"
          ? assignmentSubagentCard(currentAssignment(entry, reader.assignments), reader)
          : null;
    if (card?.kind === "workflow") {
      flush();
      rows.push({ kind: "workflow", card });
    } else if (card) {
      if (pending[0] && pending[0].origin !== card.origin) flush();
      pending.push(card);
    } else {
      flush();
      if (entry.kind !== "assignment") rows.push({ kind: "work", entry });
    }
  }
  flush();
  const groups = rows.flatMap((row) => (row.kind === "agents" ? [row.group] : []));
  const cards = rows.flatMap((row) =>
    row.kind === "agents" ? row.group.cards : row.kind === "workflow" ? [row.card] : [],
  );
  const keys = new Set(fold.keptKeys);
  if (fold.folded) for (const card of cards) if (isActiveSubagent(card)) keys.add(card.key);
  const kept = cards.filter((card) => keys.has(card.key));
  const nodeCards = kept.filter((card) => card.origin === "subagent");
  const tasks = kept.filter((card) => card.origin === "task");
  return {
    rows,
    groups,
    keptKeys: [...keys],
    keptOutside: fold.folded && nodeCards.length ? subagentGroup(nodeCards) : null,
    keptTasks: fold.folded && tasks.length ? subagentGroup(tasks) : null,
    foldLabel: workSummary(turn)?.label ?? null,
  };
}
export function foldedSubagentSummary(label: string, count: number, tasks = 0): string {
  return [
    label,
    ...(count ? [countLabel(count, "subagent")] : []),
    ...(tasks ? [countLabel(tasks, "task")] : []),
  ].join(" · ");
}
export function turnSubagentCount(turn: Turn): number {
  const nodes = (turn.nodes ?? transcriptNodes(turn.work)).filter(
    (entry) => entry.nodeKind === "subagent",
  );
  const parents = new Set(nodes.flatMap((node) => (node.parentNodeId ? [node.parentNodeId] : [])));
  return nodes.filter((node) => !parents.has(node.nodeId)).length;
}
export function visibleAgentMembers(
  cards: readonly AgentCard[],
  showAll = false,
): { cards: readonly AgentCard[]; remaining: number } {
  const visible = showAll
    ? cards
    : cards.filter((card, index) => index < 8 || card.tone === "needs-you");
  return { cards: visible, remaining: cards.length - visible.length };
}

export function transcriptNodes(entries: readonly TranscriptEntry[]): readonly NodeEntry[] {
  return entries.filter((entry): entry is NodeEntry => entry.kind === "node");
}

export function executionNodeEntry(node: ExecutionNodeView): NodeEntry {
  return {
    stopSupported: node.stopSupported ?? false,
    stopping: node.stopping ?? false,
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

function spokenDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const units = [
    [Math.floor(seconds / 3_600), "hour"],
    [Math.floor(seconds / 60) % 60, "minute"],
    [seconds % 60, "second"],
  ] as const;
  const spoken = units
    .filter(([count]) => count > 0)
    .slice(0, 2)
    .map(([count, unit]) => `${count} ${unit}${count === 1 ? "" : "s"}`);
  return spoken.length ? spoken.join(" ") : "0 seconds";
}
/** A card's accessible name; elapsed is read once, never as it ticks. */
export function agentCardLabel(card: AgentCard, now: number, owner: string | null = null): string {
  if (card.origin === "task")
    return `${card.title}${owner ? `, ${owner}` : ""}, task, ${card.word}${card.line ? `. ${card.line.text}` : ""}. Open task`;
  if (card.workflow) {
    const phase = card.workflow.phases.findIndex(
      (candidate) => candidate.index === card.workflow?.openPhase,
    );
    return [
      `${card.title}, workflow, ${card.word}`,
      ...(phase >= 0 ? [`phase ${phase + 1} of ${card.workflow.phases.length}`] : []),
    ].join(", ");
  }
  const end = card.endedAt ? Date.parse(card.endedAt) : now;
  return `${card.title}, subagent, ${card.word}, ${spokenDuration(end - Date.parse(card.startedAt))}.${card.line ? ` ${card.line.text}` : ""}`;
}
export function agentPhaseLabel(phase: WorkflowView["phases"][number]): string {
  return `Phase ${phase.index + 1}, ${phase.title}, ${phase.word}, ${phase.settled} of ${phase.total} finished`;
}
/** The word in a workflow member's fixed-width status slot. */
export function agentMemberWord(card: AgentCard): string {
  return card.tone === "failed" ? card.word.replace(words.failed, "Failed") : card.word;
}
