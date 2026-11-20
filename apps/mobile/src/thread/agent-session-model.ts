import {
  agentWithdrawnLine,
  operationDecisionField,
  operationRequestView,
  sessionAgent,
  sessionSlotFromHome,
  sessionTaskRow,
  sessionTaskView,
  tabAgentLine,
  workWords,
  type AgentSessionSlot,
  type AgentWho,
  type HostSnapshot,
  type OperationRequestView,
  type SessionAgent,
  type SessionTaskView,
} from "@opensteer/client/host";
import type { Request } from "@opensteer/core";

/**
 * The phone's reading of a connected agent's own work, from the shared view model and the
 * snapshot's optional `agentWork` slots. Everything here is pure, so each state is tested
 * without drawing anything.
 */

interface AgentWorkSource {
  readonly threads: HostSnapshot["threads"];
  readonly agentWork?: HostSnapshot["agentWork"] | undefined;
}

function slotOf(snapshot: AgentWorkSource, threadId: string): AgentSessionSlot | null {
  // The preview's slot, else what the Home reports on the task row itself.
  return (
    snapshot.agentWork?.sessions?.[threadId] ??
    sessionSlotFromHome(snapshot.threads.find(({ id }) => id === threadId)?.externalWork)
  );
}

function withdrawnFor(snapshot: AgentWorkSource, slot: AgentSessionSlot | null): string | null {
  return slot === null ? null : (snapshot.agentWork?.withdrawn?.[slot.connection.id] ?? null);
}

/** A task's session view, or null for any task a connected agent doesn't work itself. */
export function sessionTaskOf(snapshot: AgentWorkSource, threadId: string): SessionTaskView | null {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  if (!thread) return null;
  const slot = slotOf(snapshot, threadId);
  return sessionTaskView({
    thread: { status: thread.status, agentSessionId: thread.agentSessionId ?? null },
    slot,
    withdrawnAt: withdrawnFor(snapshot, slot),
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
  readonly request: Request;
  readonly view: OperationRequestView;
}

/**
 * A session task's direct-operation Requests, from the task's own Requests: the open ones
 * first, then the settled ones.
 */
export function operationRequestsOf(
  snapshot: AgentWorkSource,
  threadId: string,
  requests: readonly Request[],
): readonly OperationRequestItem[] {
  const session = slotOf(snapshot, threadId);
  const items = requests.flatMap((request): OperationRequestItem[] => {
    if (operationDecisionField(request) === null) return [];
    const view = operationRequestView({
      request,
      slot: snapshot.agentWork?.requests?.[request.id],
      session,
      withdrawnAt: withdrawnFor(snapshot, session),
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
  snapshot: { readonly agentWork?: HostSnapshot["agentWork"] | undefined },
  input: {
    readonly request: Parameters<typeof operationRequestView>[0]["request"];
    readonly threadId: string;
  },
): OperationRequestView | null {
  const session = snapshot.agentWork?.sessions?.[input.threadId] ?? null;
  return operationRequestView({
    request: input.request,
    slot: snapshot.agentWork?.requests?.[input.request.id],
    session,
    withdrawnAt: session ? (snapshot.agentWork?.withdrawn?.[session.connection.id] ?? null) : null,
  });
}

/** What a tab says of the connected agent using it, and the session its Stop ends. */
export function placeSessionLine(
  snapshot: AgentWorkSource,
  input: {
    readonly tabId: string | null;
    /** The place's occupants, acting first. */
    readonly occupants: readonly { readonly threadId: string; readonly title: string }[];
  },
): {
  readonly agent: SessionAgent;
  readonly threadId: string;
  readonly line: string;
  readonly stop: { readonly sessionId: string } | null;
} | null {
  if (input.tabId === null) return null;
  for (const occupant of input.occupants) {
    const slot = slotOf(snapshot, occupant.threadId);
    if (slot === null) continue;
    const said = tabAgentLine({
      tabId: input.tabId,
      occupant,
      slot,
      sharedTabs: snapshot.agentWork?.sharedTabs,
      withdrawnAt: withdrawnFor(snapshot, slot),
    });
    if (said === null) continue;
    return {
      agent: sessionAgent(slot.connection, withdrawnFor(snapshot, slot)),
      threadId: occupant.threadId,
      ...said,
    };
  }
  return null;
}

/** "Says it is Grok" for a self-given name; the Home's own heading otherwise. */
export function whoHeading(who: AgentWho): string {
  return who.selfAsserted ? workWords("who.saysItIs", { name: who.heading }) : who.heading;
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
  /** "Only approve if you started this yourself.", on consent only. */
  readonly warning: string | null;
} {
  const line = agentWithdrawnLine(who);
  return {
    heading: whoHeading(who),
    detail: who.detail,
    verified: who.verified,
    withdrawn:
      line === null
        ? null
        : { line, detail: workWords("who.withdrawnDetail", { agent: who.heading }) },
    warning: options.consent ? who.warning : null,
  };
}
