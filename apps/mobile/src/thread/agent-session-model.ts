import {
  agentWithdrawnLine,
  operationDecisionField,
  operationRequestView,
  sessionAgent,
  sessionAgentPart,
  sessionSlotFromHome,
  sessionTaskRow,
  sessionTaskView,
  tabAgentLine,
  tabNeedsYouParts,
  workSentence,
  workWords,
  type AgentSessionSlot,
  type AgentWho,
  type HostSnapshot,
  type OperationRequestView,
  type RequestView,
  type SentencePart,
  type SessionAgent,
  type SessionTaskView,
  phoneSentence,
} from "@opensteer/client/host";
import type { AgentOperationView } from "@opensteer/core";

type AgentWorkSource = Pick<HostSnapshot, "threads">;

function slotOf(snapshot: AgentWorkSource, threadId: string): AgentSessionSlot | null {
  return sessionSlotFromHome(snapshot.threads.find(({ id }) => id === threadId)?.externalWork);
}

/** A task's session view, or null for any task a connected agent doesn't work itself. */
export function sessionTaskOf(
  snapshot: AgentWorkSource,
  threadId: string,
  operations?: readonly AgentOperationView[],
): SessionTaskView | null {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  if (!thread) return null;
  const slot = sessionSlotFromHome(thread.externalWork, operations);
  return sessionTaskView({
    thread: { status: thread.status, agentSessionId: thread.agentSessionId ?? null },
    slot,
  });
}

/** A session task's row in Tasks, or null for any other task. */
export function sessionRowOf(
  snapshot: AgentWorkSource,
  threadId: string,
): ReturnType<typeof sessionTaskRow> {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  if (!thread) return null;
  return sessionTaskRow({
    thread: { status: thread.status, agentSessionId: thread.agentSessionId ?? null },
    slot: slotOf(snapshot, threadId),
  });
}

/** One direct operation's Request, with what the card shows of it. */
export interface OperationRequestItem {
  readonly request: RequestView;
  readonly view: OperationRequestView;
}

/**
 * A session task's direct-operation Requests, from the task's own Requests: the open ones
 * first, then the settled ones.
 */
export function operationRequestsOf(
  snapshot: AgentWorkSource,
  threadId: string,
  requests: readonly RequestView[],
): readonly OperationRequestItem[] {
  const session = slotOf(snapshot, threadId);
  const items = requests.flatMap((request): OperationRequestItem[] => {
    if (operationDecisionField(request) === null) return [];
    const view = operationRequestView({
      request,
      session,
    });
    return view === null ? [] : [{ request, view }];
  });
  return [
    ...items.filter(({ view }) => view.state === "pending"),
    ...items.filter(({ view }) => view.state !== "pending"),
  ];
}

/** How a Needs you row names a direct operation's Request: its agent and the Home's question. */
export function needsYouOperation(
  snapshot: AgentWorkSource,
  input: {
    readonly request: Parameters<typeof operationRequestView>[0]["request"];
    readonly threadId: string;
  },
): OperationRequestView | null {
  return operationRequestView({
    request: input.request,
    session: slotOf(snapshot, input.threadId),
  });
}

/** What a tab says of the connected agent using it, and the session its Stop ends. */
export function placeSessionLine(
  snapshot: AgentWorkSource,
  input: {
    readonly tabId: string | null;
    readonly sharedFromChrome?: boolean;
    /** The place's occupants, acting first. */
    readonly occupants: readonly { readonly threadId: string; readonly title: string }[];
  },
): {
  readonly agent: SessionAgent;
  readonly threadId: string;
  readonly line: string;
  readonly lineParts: readonly SentencePart[];
  readonly needsYouParts: readonly SentencePart[];
  readonly stopLabelParts: readonly SentencePart[];
  readonly stop: { readonly sessionId: string } | null;
} | null {
  if (input.tabId === null) return null;
  for (const occupant of input.occupants) {
    const slot = slotOf(snapshot, occupant.threadId);
    if (slot === null) continue;
    const said = tabAgentLine({
      occupant,
      slot,
      sharedFromChrome: input.sharedFromChrome === true,
    });
    if (said === null) continue;
    const agent = sessionAgent(slot.connection);
    return {
      agent,
      threadId: occupant.threadId,
      needsYouParts: tabNeedsYouParts(slot.connection),
      stopLabelParts: workSentence("work.stop", { agent: sessionAgentPart(agent) }),
      ...said,
    };
  }
  return null;
}

/** "Says it is “Grok”" for a self-given name; the Home's own heading otherwise. */
export function whoHeading(who: AgentWho): string {
  return who.selfAsserted
    ? phoneSentence(workSentence("who.saysItIs", { name: { name: who.heading } }))
    : who.heading;
}

/** The identity lines a consent screen or an agent's page shows, in order. */
export function whoLines(
  who: AgentWho,
  options: { readonly consent: boolean },
): {
  readonly heading: string;
  readonly detail: string;
  readonly verified: boolean;
  /** "No longer verified since …" with what to do about it, once it was withdrawn. */
  readonly withdrawn: { readonly line: string; readonly detail: string } | null;
  /** "Only allow this if you started it yourself.", on consent only. */
  readonly warning: string | null;
} {
  const line = agentWithdrawnLine(who);
  return {
    heading: whoHeading(who),
    detail: phoneSentence(who.detailParts),
    verified: who.verified,
    withdrawn: line === null ? null : { line, detail: workWords("who.withdrawnDetail") },
    warning: options.consent ? who.warning : null,
  };
}
