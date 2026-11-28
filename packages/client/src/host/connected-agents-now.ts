import {
  agentGrantPluginTargetKey,
  type AgentOperationTarget,
  type AgentOperationView,
} from "@opensteer/core";
import {
  agentPlaceParts,
  connectedAgentNamePart,
  needsYouAgentRequest,
  operationActionParts,
  operationRequestView,
  sessionQuestions,
  sessionSlotFromHome,
  sessionTaskView,
  operationTime,
  sessionAgent,
  type SessionAgent,
} from "./agent-work.js";
import { workSentence, workWords, type SafeWorkCopyValues } from "./agent-work-copy.js";
import type { ThreadSummary, WaitingRequestView } from "./client.js";
import { joinSentenceParts, named, plainSentence, type SentencePart } from "./sentence-parts.js";
import { formatRelativeTime } from "./thread-list-model.js";
import { requestsWaitingOn } from "./waiting-requests.js";

export type ConnectedAgentNowTask = Pick<ThreadSummary, "id" | "status" | "externalWork">;

export interface ConnectedAgentNow {
  readonly agent: SessionAgent;
  readonly connectionId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly state: "working" | "needs-you";
  readonly places: readonly AgentOperationTarget[];
  readonly action: string | null;
  readonly actionParts: readonly SentencePart[];
  readonly waiting: WaitingRequestView | null;
}

export function connectedAgentsNow(input: {
  readonly tasks: readonly ConnectedAgentNowTask[];
  readonly waitingRequests: readonly WaitingRequestView[];
  /** The task activity the client has read. */
  readonly operations?: readonly AgentOperationView[] | undefined;
  /** Once read, the profile inventory is authority on which browser targets still exist. */
  readonly profileIds?: ReadonlySet<string> | undefined;
}): {
  readonly agents: readonly ConnectedAgentNow[];
  readonly headline: string | null;
  readonly headlineParts: readonly SentencePart[];
} {
  const seen = new Set<string>();
  const needsYou: ConnectedAgentNow[] = [];
  const working: ConnectedAgentNow[] = [];
  for (const task of input.tasks) {
    const work = task.externalWork;
    if (!work || work.status !== "active" || work.endReason || seen.has(work.sessionId)) continue;
    const waiting =
      requestsWaitingOn(input.waitingRequests, task.id).find(
        ({ request }) => request.originatingAgentSessionId === work.sessionId,
      ) ?? null;
    if (!waiting && task.status !== "running" && task.status !== "waiting") continue;
    seen.add(work.sessionId);
    const operations = (input.operations ?? []).filter(
      (operation) => operation.taskId === task.id && operation.sessionId === work.sessionId,
    );
    let latest: AgentOperationView | undefined;
    let latestTime = -Infinity;
    for (const operation of operations) {
      const at = Date.parse(operationTime(operation));
      if (!latest || at > latestTime || (at === latestTime && operation.id > latest.id)) {
        latest = operation;
        latestTime = at;
      }
    }
    const exists = (target: AgentOperationTarget) =>
      target.grant.kind !== "browser-profile" ||
      !input.profileIds ||
      input.profileIds.has(target.grant.profileId);
    const targets = [
      waiting?.request.agentOperation?.target,
      ...operations.filter(({ outcome }) => outcome === null).map(({ target }) => target),
    ].filter((target): target is AgentOperationTarget => target !== undefined && exists(target));
    // When no action is in flight, the latest recorded action is the only place we can name.
    if (targets.length === 0 && latest) {
      if (!exists(latest.target) && !waiting) continue;
      if (exists(latest.target) && latest.ending !== "narrowed") targets.push(latest.target);
    }
    const question = waiting
      ? (needsYouAgentRequest(waiting.request, sessionSlotFromHome(work))?.question ??
        waiting.request.presentation.title)
      : null;
    const actionParts = question
      ? [question]
      : latest && exists(latest.target) && latest.ending !== "narrowed"
        ? operationActionParts(latest)
        : [];
    const entry: ConnectedAgentNow = {
      agent: sessionAgent(work.connection),
      connectionId: work.connection.id,
      threadId: task.id,
      sessionId: work.sessionId,
      state: waiting || task.status === "waiting" ? "needs-you" : "working",
      places: distinctAgentPlaces(targets),
      action: actionParts.length ? plainSentence(actionParts, { quoteNames: false }) : null,
      actionParts,
      waiting,
    };
    (entry.state === "needs-you" ? needsYou : working).push(entry);
  }

  const waitingConnections = new Map(needsYou.map((entry) => [entry.connectionId, entry]));
  const workingConnections = new Map<string, ConnectedAgentNow[]>();
  for (const entry of working) {
    if (waitingConnections.has(entry.connectionId)) continue;
    const sessions = workingConnections.get(entry.connectionId);
    if (sessions) sessions.push(entry);
    else workingConnections.set(entry.connectionId, [entry]);
  }
  const headlineParts = headlineFor(
    [...waitingConnections.values()],
    [...workingConnections.values()],
  );
  return {
    agents: [...needsYou, ...working],
    headline: headlineParts.length ? plainSentence(headlineParts) : null,
    headlineParts,
  };
}

export function distinctAgentPlaces(
  targets: readonly AgentOperationTarget[],
): AgentOperationTarget[] {
  return [
    ...new Map(
      targets.map((target) => [
        JSON.stringify([placeResourceKey(target.grant), target.device?.id ?? null]),
        target,
      ]),
    ).values(),
  ];
}

function placeResourceKey(grant: AgentOperationTarget["grant"]): string {
  switch (grant.kind) {
    case "browser-profile":
      return `browser-profile:${grant.profileId}`;
    case "chrome-tabs":
      return `chrome-tabs:${grant.sourceId}`;
    case "computer-app":
      return `computer-app:${grant.approvalId}`;
    case "plugin":
      return `plugin:${agentGrantPluginTargetKey(grant.target)}`;
    case "device":
      return "device";
  }
}

function headlineFor(
  needsYou: readonly ConnectedAgentNow[],
  working: readonly (readonly ConnectedAgentNow[])[],
): readonly SentencePart[] {
  if (needsYou.length > 0) {
    const parts =
      needsYou.length === 1
        ? singleAgentHeadline("work.waiting", needsYou[0]!.agent)
        : [workWords("now.needsYouCount", { count: needsYou.length })];
    return working.length
      ? [...parts, workWords("now.alsoWorking", { count: working.length })]
      : parts;
  }

  if (working.length > 1) return [workWords("now.workingCount", { count: working.length })];
  const sessions = working[0];
  const only = sessions?.[0];
  if (!only) return [];
  const places = distinctAgentPlaces(sessions.flatMap((entry) => entry.places));
  if (places.length > 1)
    return singleAgentHeadline("now.workingInPlaces", only.agent, { count: places.length });
  if (places[0]) return singleAgentHeadline("now.workingIn", only.agent, { place: places[0].name });
  return singleAgentHeadline("work.working", only.agent);
}

/** Keep the name at its own boundary for the two-line sidebar, even when it is verified. */
function singleAgentHeadline(
  key: "work.waiting" | "work.working" | "now.workingInPlaces" | "now.workingIn",
  agent: SessionAgent,
  values?: SafeWorkCopyValues,
): readonly SentencePart[] {
  const [, ...detail] = workSentence(key, { agent: { name: agent.name } }, values);
  return [connectedAgentNamePart(agent), ...detail];
}

export function connectedAgentNowRow(
  entry: ConnectedAgentNow,
  sharedDeviceName?: string | null,
  distinction?: string,
) {
  const needsYou = entry.state === "needs-you";
  const status = workWords(needsYou ? "now.row.needsYou" : "now.row.working");
  const placeLines = entry.places.map((place) => agentPlaceParts(place, sharedDeviceName));
  return {
    nameParts: [connectedAgentNamePart(entry.agent)],
    placeLines,
    status,
    primaryAction: needsYou ? ("work.review" as const) : ("work.watch" as const),
    needsYou,
    detailParts: joinSentenceParts([
      [status],
      ...placeLines,
      entry.actionParts,
      distinction ? [distinction] : [],
    ]),
    request: entry.waiting?.request ?? null,
    requestId: entry.waiting?.request.id,
  };
}

export function connectedAgentNowSection(work: {
  readonly view: { readonly agents: readonly ConnectedAgentNow[] };
  readonly tasks: readonly ThreadSummary[];
  readonly activity: ReadonlyMap<string, readonly AgentOperationView[]> | undefined;
}) {
  return work.view.agents.flatMap((entry) => {
    const thread = work.tasks.find(({ id }) => id === entry.threadId);
    if (!thread) return [];
    const row = connectedAgentNowRow(entry);
    const slot = sessionSlotFromHome(
      thread.externalWork,
      work.activity?.get(thread.id)?.filter(({ sessionId }) => sessionId === entry.sessionId),
    );
    if (slot?.sessionId !== entry.sessionId) return [];
    const view = sessionTaskView({ thread, slot });
    if (!view) return [];
    const request = row.request;
    const operation = request ? operationRequestView({ request, session: slot }) : null;
    return [
      {
        entry,
        row,
        titleParts: [named(thread.title)],
        detailParts: joinSentenceParts([...row.placeLines, row.needsYou ? [row.status] : []]),
        view,
        operation: request && operation ? { request, view: operation } : null,
        question: request ? sessionQuestions([request])[0] : undefined,
      },
    ];
  });
}

/** Matching rows from different connections need a visible way to tell them apart. */
export function matchingConnectedAgentRows(
  agents: readonly ConnectedAgentNow[],
  sharedDeviceName?: string | null,
) {
  const groups = new Map<string, ConnectedAgentNow[]>();
  for (const entry of agents) {
    const row = connectedAgentNowRow(entry, sharedDeviceName);
    const key = JSON.stringify([row.nameParts, entry.state, entry.action, row.placeLines]);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const duplicates = new Map<string, ReadonlySet<string>>();
  for (const group of groups.values()) {
    const connections = new Set(group.map(({ connectionId }) => connectionId));
    if (connections.size > 1)
      for (const { sessionId } of group) duplicates.set(sessionId, connections);
  }
  return duplicates;
}

const connectedClock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export function connectedAgentRowDistinctions(
  agents: readonly ConnectedAgentNow[],
  matching: ReadonlyMap<string, ReadonlySet<string>>,
  connections: readonly { readonly id: string; readonly createdAt: string }[] | null,
  now = new Date(),
) {
  const created = new Map(connections?.map(({ id, createdAt }) => [id, createdAt]));
  const labels = new Map<string, string>();
  for (const { sessionId, connectionId } of agents) {
    const group = matching.get(sessionId);
    const joined = created.get(connectionId);
    if (!group || !joined) continue;
    const age = formatRelativeTime(joined, now);
    if (!age) continue;
    const sameAge = [...group].some((id) => {
      const other = created.get(id);
      return id !== connectionId && other && formatRelativeTime(other, now) === age;
    });
    const when = age === "now" ? "just now" : /^\d/u.test(age) ? `${age} ago` : age;
    labels.set(
      sessionId,
      `Connected ${when}${sameAge ? ` · ${connectedClock.format(new Date(joined))}` : ""}`,
    );
  }
  return labels;
}
