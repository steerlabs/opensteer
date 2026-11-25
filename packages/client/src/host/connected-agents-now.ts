import type { AgentOperationTarget, AgentOperationView } from "@opensteer/core";
import {
  operationAction,
  sessionAgent,
  sessionAgentPart,
  type SessionAgent,
} from "./agent-work.js";
import { workSentence, workWords, type SafeWorkCopyValues } from "./agent-work-copy.js";
import type { ThreadSummary, WaitingRequestView } from "./client.js";
import { plainSentence, type SentencePart } from "./sentence-parts.js";
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
  readonly waiting: WaitingRequestView | null;
}

export function connectedAgentsNow(input: {
  readonly tasks: readonly ConnectedAgentNowTask[];
  readonly waitingRequests: readonly WaitingRequestView[];
  /** The task activity the client has read, newest first. */
  readonly operations?: readonly AgentOperationView[] | undefined;
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
    const latest = operations[0];
    const targets = [
      waiting?.request.agentOperation?.target,
      ...operations.filter(({ outcome }) => outcome === null).map(({ target }) => target),
    ].filter((target): target is AgentOperationTarget => target !== undefined);
    // When no action is in flight, the latest recorded action is the only place we can name.
    if (targets.length === 0 && latest) targets.push(latest.target);
    const entry: ConnectedAgentNow = {
      agent: sessionAgent(work.connection),
      connectionId: work.connection.id,
      threadId: task.id,
      sessionId: work.sessionId,
      state: waiting || task.status === "waiting" ? "needs-you" : "working",
      places: distinctPlaces(targets),
      action: waiting?.request.presentation.title ?? (latest ? operationAction(latest) : null),
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

function distinctPlaces(targets: readonly AgentOperationTarget[]): AgentOperationTarget[] {
  return [
    ...new Map(
      targets.map((target) => [JSON.stringify([target.grant, target.device?.id]), target]),
    ).values(),
  ];
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
  const places = distinctPlaces(sessions.flatMap((entry) => entry.places));
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
  return [agent.who?.verified ? agent.name : sessionAgentPart(agent), ...detail];
}
