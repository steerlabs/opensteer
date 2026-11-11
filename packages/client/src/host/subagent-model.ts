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
import { catalogModelDisplayName } from "./model-catalog.js";
import { requestWaitingOnAssignment } from "./waiting-requests.js";

export type AgentTone = "working" | "needs-you" | "waiting" | "finished" | "failed" | "stopped";
/**
 * One phrase of a row's second line. `live` is reported progress that rolls
 * in as it changes; `attention` and `failed` carry their meaning in words,
 * which a screen may also colour.
 */
export interface AgentPhrase {
  readonly text: string;
  readonly tone: "live" | "attention" | "failed" | "quiet";
}
export interface AgentCard {
  readonly stop?: { readonly threadId: string; readonly nodeId: string } | null;
  readonly key: string;
  readonly origin: "subagent" | "task";
  readonly kind: "subagent" | "workflow";
  /** The word a lone row's second line starts with. */
  readonly noun: "Subagent" | "Task" | "Workflow";
  readonly nodeId: string | null;
  readonly parentNodeId: string | null;
  readonly title: string;
  readonly tone: AgentTone;
  readonly word: string;
  readonly moving: boolean;
  /** Live by its status, but the Host is out of reach: what it last reported. */
  readonly lastKnown: boolean;
  /** Its engine can stop it on its own, and a stop was asked for. */
  readonly stopSupported: boolean;
  readonly stopping: boolean;
  /** The one thing worth knowing, in words, for the row's second line. */
  readonly detail: readonly AgentPhrase[];
  /** The subagents it started itself, which hang one step in under it. */
  readonly children: readonly AgentCard[];
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
    /** "2 working · 1 finished", or "Not started". */
    readonly detail: readonly AgentPhrase[];
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
  /** "3 subagents". */
  readonly label: string;
  /** "1 needs you · 2 working · 1 finished". */
  readonly detail: readonly AgentPhrase[];
  /** The most urgent member, whose mark the group wears. */
  readonly lead: AgentCard;
  /** Thirty or more members list as one line each. */
  readonly compact: boolean;
  /** "3 subagents: 2 working, 1 finished". */
  readonly name: string;
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
  const lastKnown = cards.filter((card) => card.lastKnown).length;
  const detail: AgentPhrase[] = [
    ...(counts["needs-you"]
      ? [
          {
            text: `${counts["needs-you"]} ${counts["needs-you"] === 1 ? "needs" : "need"} you`,
            tone: "attention" as const,
          },
        ]
      : []),
    ...(lastKnown
      ? [{ text: `${lastKnown} last known`, tone: "quiet" as const }]
      : counts.working
        ? [{ text: `${counts.working} working`, tone: "quiet" as const }]
        : []),
    ...(counts.finished ? [{ text: `${counts.finished} finished`, tone: "quiet" as const }] : []),
    ...(counts.failed
      ? [{ text: `${counts.failed} couldn't finish`, tone: "failed" as const }]
      : []),
    ...(counts.stopped ? [{ text: `${counts.stopped} stopped`, tone: "quiet" as const }] : []),
  ];
  const label = countLabel(cards.length, noun);
  return {
    key: first.key,
    noun,
    cards,
    label,
    detail,
    lead:
      cards.find((card) => card.tone === "needs-you") ??
      cards.find(isActiveSubagent) ??
      cards.find((card) => card.tone === "failed") ??
      first,
    compact: cards.length >= 30,
    name: `${label}: ${detail.map((phrase) => phrase.text).join(", ")}`,
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
/**
 * Keeps a model object's identity while its contents stay the same, so a
 * screen that draws each row once per object redraws only what changed: one
 * subagent's progress leaves every other row the same object.
 */
export class SubagentCache {
  readonly #items = new Map<string, unknown>();
  keep<T>(key: string, next: T): T {
    const prior = this.#items.get(key) as T | undefined;
    if (prior !== undefined && sameShape(prior, next)) return prior;
    this.#items.set(key, next);
    return next;
  }
}
function sameShape(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    sameShape((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}
/** Subagents this screen asked to stop, so a stopped one can say who stopped it. */
const stoppedHere = new Set<string>();
export function noteSubagentStop(nodeId: string): void {
  stoppedHere.add(nodeId);
}
function firstLine(text: string | null | undefined): string | null {
  return subagentPreview(text?.split("\n").find((line) => line.trim().length > 0));
}
export function nodeSubagentCard(
  node: NodeEntry,
  threadId: string,
  nodes: readonly NodeEntry[] = [],
  reader?: SubagentReader,
  cache?: SubagentCache,
  ancestors: ReadonlySet<string> = new Set(),
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
    node.nodeKind === "workflow" ? workflowView(node, threadId, nodes, reader, cache) : null;
  const lineage = new Set(ancestors).add(node.nodeId);
  const children =
    node.nodeKind === "workflow"
      ? []
      : nodes.flatMap((child) => {
          if (child.parentNodeId !== node.nodeId || lineage.has(child.nodeId)) return [];
          const card = nodeSubagentCard(child, threadId, nodes, reader, cache, lineage);
          return card ? [card] : [];
        });
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
  const stopping = node.status === "running" && node.stopping === true;
  const lastKnown = !live && node.status === "running";
  const progress = subagentPreview(node.progress);
  const waitingOn =
    tone === "working" && !progress
      ? children.find((child) => child.tone === "working" || child.tone === "needs-you")
      : undefined;
  const quiet = (text: string): AgentPhrase => ({ text, tone: "quiet" });
  const detail: AgentPhrase[] = workflow
    ? [quiet(workflow.summary)]
    : lastKnown
      ? [quiet("Last known"), ...(progress ? [quiet(progress)] : [])]
      : stopping
        ? [quiet("Stopping…")]
        : tone === "needs-you"
          ? [{ text: "Waiting for your answer", tone: "attention" }]
          : tone === "waiting"
            ? [quiet("Waiting for an answer")]
            : tone === "working"
              ? waitingOn
                ? [quiet(`Waiting for ${waitingOn.title}`)]
                : [
                    progress
                      ? { text: progress, tone: "live" }
                      : quiet(firstLine(node.prompt) ?? "Starting"),
                  ]
              : tone === "finished"
                ? [quiet(subagentPreview(node.result) ?? "Finished")]
                : tone === "failed"
                  ? [
                      { text: "Couldn't finish", tone: "failed" },
                      ...(subagentPreview(node.result)
                        ? [quiet(subagentPreview(node.result)!)]
                        : []),
                    ]
                  : [
                      quiet("Stopped"),
                      ...(subagentPreview(node.result)
                        ? [quiet(subagentPreview(node.result)!)]
                        : stoppedHere.has(node.nodeId)
                          ? [quiet("Stopped by you")]
                          : []),
                    ];
  const card: AgentCard = {
    // One waiting on the person is answered, not stopped: its question is the way out.
    stop:
      live &&
      node.status === "running" &&
      node.stopSupported &&
      !node.stopping &&
      tone !== "needs-you"
        ? { threadId, nodeId: node.nodeId }
        : null,
    key: `node:${node.nodeId}`,
    origin: "subagent",
    kind: node.nodeKind,
    noun: node.nodeKind === "workflow" ? "Workflow" : "Subagent",
    nodeId: node.nodeId,
    parentNodeId: node.parentNodeId,
    title,
    tone,
    word: `${lastKnown ? "Last known: " : ""}${stopping ? "Stopping" : words[tone]}`,
    moving: live && tone === "working" && !node.stopping,
    lastKnown,
    stopSupported: node.stopSupported === true,
    stopping,
    detail,
    children,
    line,
    modelLabel: model
      ? `${model}${node.effort ? ` · ${node.effort[0]!.toUpperCase()}${node.effort.slice(1)}` : ""}`
      : null,
    startedAt: node.createdAt,
    endedAt: node.completedAt,
    opens: { kind: "subagent", threadId, nodeId: node.nodeId },
    requestId: tone === "needs-you" ? (answerable?.id ?? null) : null,
    announcement: `${title} ${stopping ? "is stopping" : tone === "working" ? "is working" : words[tone].toLowerCase()}`,
    workflow,
    task: null,
  };
  return cache ? cache.keep(card.key, card) : card;
}
function workflowView(
  node: NodeEntry,
  threadId: string,
  nodes: readonly NodeEntry[],
  reader?: SubagentReader,
  cache?: SubagentCache,
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
          const card = nodeSubagentCard(
            child,
            threadId,
            nodes,
            reader,
            cache,
            new Set([node.nodeId]),
          );
          return card ? [card] : [];
        });
      const settled = members.filter((card) => !isActiveSubagent(card)).length;
      const failed = members.filter((card) => card.tone === "failed").length;
      const working = members.filter(isActiveSubagent).length;
      const finished = members.filter((card) => card.tone === "finished").length;
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
        detail: members.length
          ? [
              ...(working ? [{ text: `${working} working`, tone: "quiet" as const }] : []),
              ...(finished ? [{ text: `${finished} finished`, tone: "quiet" as const }] : []),
              ...(failed ? [{ text: `${failed} couldn't finish`, tone: "failed" as const }] : []),
              ...(settled - finished - failed
                ? [{ text: `${settled - finished - failed} stopped`, tone: "quiet" as const }]
                : []),
            ]
          : [{ text: "Not started", tone: "quiet" as const }],
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
  const position = phases.findIndex((phase) => phase.index === current?.index);
  const summary =
    !settled && current
      ? `${current.title}, phase ${position + 1} of ${phases.length}`
      : `${phases.length} ${phases.length === 1 ? "phase" : "phases"}`;
  return { phases, openPhase, summary };
}
export function assignmentSubagentCard(
  assignment: AssignmentSummary,
  reader: AssignmentReader,
  cache?: SubagentCache,
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
  const said = subagentPreview(presentation.detail?.text);
  const result = subagentPreview(assignment.resultPreview);
  const quiet = (text: string): AgentPhrase => ({ text, tone: "quiet" });
  const detail: AgentPhrase[] =
    tone === "needs-you"
      ? [{ text: "Asked you a question", tone: "attention" }]
      : tone === "working"
        ? [said ? { text: said, tone: presentation.moving ? "live" : "quiet" } : quiet("Working")]
        : tone === "finished"
          ? [quiet(result ?? presentation.word)]
          : tone === "failed"
            ? [{ text: "Couldn't finish", tone: "failed" }, ...(result ? [quiet(result)] : [])]
            : [quiet(presentation.word), ...(said ? [quiet(said)] : [])];
  const card: AgentCard = {
    key: `task:${assignment.id}`,
    origin: "task",
    kind: "subagent",
    noun: "Task",
    nodeId: null,
    parentNodeId: null,
    lastKnown: false,
    stopSupported: false,
    stopping: false,
    detail,
    children: [],
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
  return cache ? cache.keep(card.key, card) : card;
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
  cache?: SubagentCache,
): TurnAgents {
  const nodes = transcriptNodes(reader.transcripts[threadId] ?? []);
  const rows: SubagentTurnRow[] = [];
  let pending: AgentCard[] = [];
  const group = (cards: readonly AgentCard[], key = "") => {
    const made = subagentGroup(cards);
    return cache ? cache.keep(`group${key}:${made.key}`, made) : made;
  };
  const flush = () => {
    if (pending.length) {
      rows.push({ kind: "agents", group: group(pending) });
      pending = [];
    }
  };
  const items: (WorkEntry | AssignmentEntry)[] = [...turn.work, ...turn.assignments];
  for (const entry of items) {
    if (entry.kind === "node" && entry.nodeKind !== "task" && entry.parentNodeId) continue;
    const card =
      entry.kind === "node"
        ? nodeSubagentCard(entry, threadId, nodes, reader, cache)
        : entry.kind === "assignment"
          ? assignmentSubagentCard(currentAssignment(entry, reader.assignments), reader, cache)
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
    keptOutside: fold.folded && nodeCards.length ? group(nodeCards, ":kept") : null,
    keptTasks: fold.folded && tasks.length ? group(tasks, ":kept") : null,
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
/**
 * A row's accessible name, "Subagent Trace the payment flow, Working, 3
 * minutes. Open"; elapsed is read once, never as it ticks.
 */
export function agentCardLabel(card: AgentCard, now: number, owner: string | null = null): string {
  const end = card.endedAt ? Date.parse(card.endedAt) : now;
  const spoken = spokenDuration(end - Date.parse(card.startedAt));
  if (card.workflow) return `Workflow ${card.title}, ${card.word}: ${card.workflow.summary}`;
  return `${card.noun} ${card.title}${owner ? `, ${owner}` : ""}, ${card.word}, ${spoken}. ${card.origin === "task" ? "Open the task" : "Open"}`;
}
export function agentPhaseLabel(phase: WorkflowView["phases"][number], position: number): string {
  return `Phase ${position}, ${phase.title}: ${phase.detail.map((part) => part.text).join(", ")}`;
}
