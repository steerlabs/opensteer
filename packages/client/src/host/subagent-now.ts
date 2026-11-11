import { placeHas } from "./team-place.js";
import type { Request } from "@opensteer/core";
import { groupTranscriptEntries, type Turn } from "./agent-activity-model.js";
import { currentAssignment } from "./assignment-presentation.js";
import type { NodeEntry } from "./client.js";
import {
  assignmentSubagentCard,
  isActiveSubagent,
  nodeSubagentCard,
  subagentTitle,
  subagentTurnModel,
  transcriptNodes,
  type AgentCard,
  type AgentPhrase,
  type SubagentCache,
  type SubagentReader,
} from "./subagent-model.js";

/** One subagent or task in the open Running now list. */
export interface RunningRow {
  readonly card: AgentCard;
  /** How many steps in it hangs: one for each subagent above it that is also running. */
  readonly depth: number;
  /** The subagent or workflow that started it, when that is not the conversation. */
  readonly within: string | null;
}
/** A command the agent left running in the background. */
export interface RunningCommand {
  readonly key: string;
  readonly command: string;
  readonly startedAt: string;
}
export interface RunningNow {
  readonly rows: readonly RunningRow[];
  readonly commands: readonly RunningCommand[];
  /** "2 subagents working", "2 subagents, 1 task", or "1 command". */
  readonly count: string;
  /** What follows the count: "1 needs you · 1 working", "last known", "1 command". */
  readonly detail: readonly AgentPhrase[];
  /** The newest real progress line and whose it is. */
  readonly newest: { readonly key: string; readonly text: string } | null;
  /** The card whose mark the collapsed line wears; none when only commands run. */
  readonly lead: AgentCard | null;
  /** "Running now: 2 subagents working". */
  readonly name: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What runs in this conversation now: every live subagent (nested ones under
 * the one that started them), every live task it handed out, and every
 * command left running in the background. Null when nothing runs, which is
 * when the line leaves.
 */
export function runningNow(
  reader: SubagentReader,
  threadId: string,
  cache?: SubagentCache,
): RunningNow | null {
  const entries = reader.transcripts[threadId] ?? [];
  const nodes = transcriptNodes(entries);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const rows: RunningRow[] = [];
  const walk = (card: AgentCard, depth: number, within: string | null) => {
    if (card.workflow) {
      for (const phase of card.workflow.phases)
        for (const member of phase.members) walk(member, depth, card.title);
      return;
    }
    const live = isActiveSubagent(card);
    if (live) rows.push({ card, depth, within });
    for (const child of card.children) walk(child, live ? depth + 1 : depth, card.title);
  };
  const tops = nodes.flatMap((node) => {
    if (node.parentNodeId && byId.has(node.parentNodeId)) return [];
    const card = nodeSubagentCard(node, threadId, nodes, reader, cache);
    return card ? [card] : [];
  });
  // Whoever needs the person comes first; a nested one stays under its parent.
  const needs = (card: AgentCard): boolean =>
    card.tone === "needs-you" ||
    card.children.some(needs) ||
    (card.workflow?.phases.some((phase) => phase.members.some(needs)) ?? false);
  for (const card of [...tops].sort(
    (left, right) =>
      Number(needs(right)) - Number(needs(left)) || left.startedAt.localeCompare(right.startedAt),
  ))
    walk(card, 0, null);
  const assignments = new Map(Object.entries(reader.assignments));
  for (const entry of entries)
    if (entry.kind === "assignment")
      assignments.set(entry.assignment.id, currentAssignment(entry, reader.assignments));
  for (const assignment of assignments.values()) {
    if (assignment.origin !== "run" || assignment.parentThreadId !== threadId) continue;
    const card = assignmentSubagentCard(assignment, reader, cache);
    if (isActiveSubagent(card)) rows.push({ card, depth: 0, within: null });
  }
  const commands = nodes.flatMap((node): RunningCommand[] =>
    node.nodeKind === "task" && node.status === "running"
      ? [{ key: node.id, command: node.title, startedAt: node.createdAt }]
      : [],
  );
  if (rows.length === 0 && commands.length === 0) return null;
  const subagents = rows.filter((row) => row.card.origin === "subagent").length;
  const tasks = rows.length - subagents;
  const who = [
    ...(subagents ? [plural(subagents, "subagent")] : []),
    ...(tasks ? [plural(tasks, "task")] : []),
  ].join(", ");
  const asking = rows.filter((row) => row.card.tone === "needs-you").length;
  const offline = rows.some((row) => row.card.lastKnown);
  const working = rows.length - asking;
  const commandPhrase = commands.length
    ? [{ text: plural(commands.length, "command"), tone: "quiet" as const }]
    : [];
  const count =
    rows.length === 0
      ? plural(commands.length, "command")
      : offline || asking
        ? who
        : `${who} working`;
  const detail: AgentPhrase[] =
    rows.length === 0
      ? [{ text: "running", tone: "quiet" }]
      : offline
        ? [{ text: "last known", tone: "quiet" }, ...commandPhrase]
        : asking
          ? [
              { text: `${asking} ${asking === 1 ? "needs" : "need"} you`, tone: "attention" },
              ...(working ? [{ text: `${working} working`, tone: "quiet" as const }] : []),
              ...commandPhrase,
            ]
          : commandPhrase;
  // The newest line a subagent itself reported, never its prompt or a status of ours.
  const newest = offline
    ? null
    : (rows
        .filter((row) => row.card.moving && row.card.detail[0]?.tone === "live")
        .sort((left, right) => right.card.startedAt.localeCompare(left.card.startedAt))
        .map((row) => ({ key: row.card.key, text: row.card.detail[0]!.text }))[0] ?? null);
  const lead =
    rows.find((row) => row.card.tone === "needs-you")?.card ??
    rows.find((row) => row.card.key === newest?.key)?.card ??
    rows[0]?.card ??
    null;
  return {
    rows,
    commands,
    count,
    detail,
    newest,
    lead,
    name: `Running now: ${[count, ...detail.map((phrase) => phrase.text)].join(", ")}`,
  };
}

/**
 * Whether two Running now models say the same thing. They are rebuilt on
 * every change a screen hears; rows built through one `SubagentCache` keep
 * their identity while unchanged, so this compares them by reference.
 */
export function sameRunningNow(left: RunningNow | null, right: RunningNow | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.count === right.count &&
    left.name === right.name &&
    left.newest?.text === right.newest?.text &&
    left.newest?.key === right.newest?.key &&
    left.lead === right.lead &&
    left.commands.length === right.commands.length &&
    left.commands.every((command, index) => command.key === right.commands[index]?.key) &&
    left.rows.length === right.rows.length &&
    left.rows.every(
      (row, index) =>
        row.card === right.rows[index]?.card &&
        row.depth === right.rows[index]?.depth &&
        row.within === right.rows[index]?.within,
    )
  );
}

/** Who asked a question: the subagent, and the subagent or workflow it runs inside. */
export interface RequestAsker {
  readonly threadId: string;
  readonly nodeId: string;
  readonly title: string;
  /** "subagent", or "in Trace the payment flow" for a nested asker. */
  readonly byline: string;
  /** Whether its own view can be opened here; a team place doesn't offer it. */
  readonly opens: boolean;
}

export function requestAsker(
  reader: Pick<SubagentReader, "transcripts" | "waitingRequests" | "teamAdministrationAvailable">,
  request: Request,
): RequestAsker | null {
  const nodeId = request.originatingNodeId;
  if (nodeId === undefined || nodeId === null) return null;
  const nodes = transcriptNodes(reader.transcripts[request.originatingThreadId] ?? []);
  const node = nodes.find((candidate) => candidate.nodeId === nodeId);
  const waiting = reader.waitingRequests.find((entry) => entry.request.id === request.id);
  const title = waiting?.subagent?.title ?? node?.title;
  if (title === undefined) return null;
  const parent = node?.parentNodeId
    ? nodes.find((candidate) => candidate.nodeId === node.parentNodeId)
    : undefined;
  return {
    threadId: request.originatingThreadId,
    nodeId,
    title: subagentTitle(title),
    byline: parent ? `in ${subagentTitle(parent.title)}` : "subagent",
    opens: placeHas(reader, "subagent-detail"),
  };
}

/** Where an opened subagent stands among the ones started beside it: "2 of 3". */
export interface SubagentSiblings {
  readonly index: number;
  readonly total: number;
  readonly previous: string | null;
  readonly next: string | null;
}

/**
 * The subagents started beside this one: its workflow phase's members, its
 * parent's other subagents, or the conversation's group it started with.
 */
export function subagentSiblings(
  reader: SubagentReader,
  threadId: string,
  nodeId: string,
): SubagentSiblings | null {
  const entries = reader.transcripts[threadId] ?? [];
  const nodes = transcriptNodes(entries);
  const node = nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.nodeKind === "task") return null;
  let ids: readonly string[] = [nodeId];
  if (node.parentNodeId) {
    const parent = nodes.find((candidate) => candidate.nodeId === node.parentNodeId);
    ids = nodes
      .filter(
        (candidate) =>
          candidate.nodeKind !== "task" &&
          candidate.parentNodeId === node.parentNodeId &&
          (parent?.nodeKind !== "workflow" ||
            (candidate.phaseIndex ?? 0) === (node.phaseIndex ?? 0)),
      )
      .map((candidate) => candidate.nodeId);
  } else {
    for (const group of groupTranscriptEntries(entries)) {
      if (group.kind !== "turn") continue;
      const found = turnGroupIds(group.turn, threadId, reader, nodeId);
      if (found) {
        ids = found;
        break;
      }
    }
  }
  const index = ids.indexOf(nodeId);
  if (index < 0) return null;
  return {
    index,
    total: ids.length,
    previous: ids[index - 1] ?? null,
    next: ids[index + 1] ?? null,
  };
}

function turnGroupIds(
  turn: Turn,
  threadId: string,
  reader: SubagentReader,
  nodeId: string,
): readonly string[] | null {
  if (!turn.work.some((entry) => entry.kind === "node" && entry.nodeId === nodeId)) return null;
  for (const row of subagentTurnModel(turn, threadId, reader).rows) {
    const cards =
      row.kind === "agents" ? row.group.cards : row.kind === "workflow" ? [row.card] : [];
    const ids = cards.flatMap((card) => (card.nodeId ? [card.nodeId] : []));
    if (ids.includes(nodeId)) return ids;
  }
  return null;
}

/** The conversation, then every subagent above this one, outermost first. */
export function subagentLineage(
  nodes: readonly NodeEntry[],
  nodeId: string,
): readonly { readonly nodeId: string; readonly title: string }[] {
  const chain: { nodeId: string; title: string }[] = [];
  const seen = new Set([nodeId]);
  let parentId = nodes.find((node) => node.nodeId === nodeId)?.parentNodeId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodes.find((node) => node.nodeId === parentId);
    if (!parent) break;
    chain.unshift({ nodeId: parent.nodeId, title: subagentTitle(parent.title) });
    parentId = parent.parentNodeId;
  }
  return chain;
}

/** What the opened subagent's footer says in the composer's place. */
export interface SubagentFooter {
  /** Who it reports to: its parent subagent, or the conversation. */
  readonly reportsTo: string;
  /** Why there is no Stop while it runs, in one plain sentence, or null. */
  readonly noStop: string | null;
}

export function subagentFooter(
  card: AgentCard,
  reportsTo: string,
  engineName: string | null,
): SubagentFooter {
  const runs = card.tone === "working" || card.tone === "waiting";
  return {
    reportsTo,
    noStop:
      runs && !card.lastKnown && !card.stopping && !card.stopSupported
        ? `${engineName ?? "Its engine"} can't stop one ${card.kind === "workflow" ? "workflow" : "subagent"}; it stops with its turn.`
        : null,
  };
}
