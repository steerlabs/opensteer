import {
  AgentOperationIdSchema,
  AgentSessionIdSchema,
  DeviceIdSchema,
  RequestIdSchema,
  RequestSchema,
  ThreadIdSchema,
  type AgentOperationTarget,
  type AgentOperationView,
  type Request,
} from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import type { AgentSessionSlot, SessionConnection } from "../host/agent-work.js";
import type { ThreadSummary } from "../host/client.js";

/**
 * Connected agents working tasks themselves (`?mock-agent-work`): one task working, one
 * waiting on the person's answer, one the person stopped, and one that ended when its agent
 * was disconnected. `?mock-agent-work=long` gives the waiting one long names and no reason.
 */
export const mockAgentWorkThreads = {
  working: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-0000000000a1"),
  waiting: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-0000000000a2"),
  stopped: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-0000000000a3"),
  ended: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-0000000000a4"),
} as const;
export const mockAgentOperationRequestId = RequestIdSchema.parse(
  "req_00000000-0000-4000-8000-0000000000b1",
);
const studioMac = {
  id: DeviceIdSchema.parse("rnr_00000000-0000-4000-8000-0000000000c1"),
  name: "Studio Mac",
};

function profile(name: string): AgentOperationTarget {
  return {
    grant: { kind: "browser-profile", profileId: "bpr_00000000-0000-4000-8000-000000000003" },
    name,
    device: studioMac,
  };
}

function connectionOf(connections: readonly AgentConnection[], label: string): SessionConnection {
  const found = connections.find((connection) => connection.label === label);
  if (!found) throw new Error(`No mock connection named ${label}.`);
  return found;
}

export function mockAgentWork(input: {
  readonly now: Date;
  readonly userId: string;
  readonly template: ThreadSummary;
  readonly connections: readonly AgentConnection[];
  /** Long profile, device, tab and task names, and a Request without the agent's reason. */
  readonly long?: boolean;
}): {
  readonly threads: readonly ThreadSummary[];
  readonly requests: Readonly<Record<string, readonly Request[]>>;
  readonly operations: readonly { connectionId: string; operation: AgentOperationView }[];
} {
  const at = (minutesAgo: number) =>
    new Date(input.now.getTime() - minutesAgo * 60_000).toISOString();
  let ops = 0;
  const op = (
    taskId: string,
    sessionId: string,
    patch: Partial<AgentOperationView> & Pick<AgentOperationView, "tool" | "target">,
    minutesAgo: number,
  ): AgentOperationView => {
    ops += 1;
    return {
      id: AgentOperationIdSchema.parse(
        `aop_00000000-0000-4000-8000-0000000001${String(ops).padStart(2, "0")}`,
      ),
      sessionId: AgentSessionIdSchema.parse(sessionId),
      taskId: ThreadIdSchema.parse(taskId),
      mode: "approval-required",
      effect: "write",
      state: "completed",
      decision: { by: "person", requestId: mockAgentOperationRequestId },
      outcome: "completed",
      requestId: null,
      createdAt: at(minutesAgo),
      handedOffAt: at(minutesAgo),
      completedAt: at(minutesAgo - 0.2),
      ...patch,
    };
  };
  const sessions = {
    working: "ags_00000000-0000-4000-8000-0000000000d1",
    waiting: "ags_00000000-0000-4000-8000-0000000000d2",
    stopped: "ags_00000000-0000-4000-8000-0000000000d3",
    ended: "ags_00000000-0000-4000-8000-0000000000d4",
  } as const;
  const claude = connectionOf(input.connections, "Claude");
  const grok = connectionOf(input.connections, "Grok");
  const errand = connectionOf(input.connections, "Errand");
  const shop = connectionOf(input.connections, "Shop helper");
  const lisbon = profile("Travel");
  const shopping = input.long
    ? "Household shopping and weekly groceries (shared with family)"
    : "Shopping";
  const slots: Record<string, AgentSessionSlot> = {
    [mockAgentWorkThreads.working]: {
      sessionId: sessions.working,
      connection: claude,
      status: "active",
      endReason: null,
      operations: [
        op(
          mockAgentWorkThreads.working,
          sessions.working,
          { tool: "tab_list", target: lisbon, effect: "read", decision: { by: "structural-read" } },
          12,
        ),
        op(
          mockAgentWorkThreads.working,
          sessions.working,
          {
            tool: "tab_open",
            target: lisbon,
            mode: "full-access",
            decision: { by: "full-access" },
          },
          11,
        ),
        op(
          mockAgentWorkThreads.working,
          sessions.working,
          {
            tool: "browser_use",
            target: lisbon,
            mode: "auto",
            decision: { by: "reviewer" },
            outcome: "failed",
            state: "failed",
          },
          6,
        ),
        op(
          mockAgentWorkThreads.working,
          sessions.working,
          {
            tool: "browser_use",
            target: lisbon,
            mode: "full-access",
            decision: { by: "full-access" },
            outcome: "unknown",
            state: "unknown",
            completedAt: null,
          },
          3,
        ),
        op(
          mockAgentWorkThreads.working,
          sessions.working,
          {
            tool: "browser_use",
            target: lisbon,
            mode: "full-access",
            decision: { by: "full-access" },
            outcome: null,
            state: "handed-off",
            completedAt: null,
          },
          0.5,
        ),
      ],
    },
    [mockAgentWorkThreads.waiting]: {
      sessionId: sessions.waiting,
      connection: grok,
      status: "active",
      endReason: null,
      operations: [
        op(
          mockAgentWorkThreads.waiting,
          sessions.waiting,
          {
            tool: "tab_list",
            target: profile(shopping),
            effect: "read",
            decision: { by: "structural-read" },
          },
          4,
        ),
        op(
          mockAgentWorkThreads.waiting,
          sessions.waiting,
          {
            tool: "browser_use",
            target: profile(shopping),
            decision: null,
            outcome: null,
            state: "pending",
            requestId: mockAgentOperationRequestId,
            handedOffAt: null,
            completedAt: null,
          },
          1,
        ),
      ],
    },
    [mockAgentWorkThreads.stopped]: {
      sessionId: sessions.stopped,
      connection: errand,
      status: "ended",
      endReason: "stopped",
      operations: [
        op(
          mockAgentWorkThreads.stopped,
          sessions.stopped,
          { tool: "tab_open", target: profile("Personal") },
          90,
        ),
        op(
          mockAgentWorkThreads.stopped,
          sessions.stopped,
          {
            tool: "browser_use",
            target: profile("Personal"),
            decision: { by: "refused", reason: "person", message: "You didn’t allow it." },
            outcome: "refused",
            state: "refused",
            handedOffAt: null,
          },
          88,
        ),
      ],
    },
    [mockAgentWorkThreads.ended]: {
      sessionId: sessions.ended,
      connection: shop,
      status: "ended",
      endReason: "revoked",
      operations: [
        op(
          mockAgentWorkThreads.ended,
          sessions.ended,
          {
            tool: "browser_use",
            target: profile("Shopping"),
            mode: "full-access",
            decision: { by: "full-access" },
            outcome: "unknown",
            state: "unknown",
            completedAt: null,
          },
          45,
        ),
      ],
    },
  };
  const task = (
    id: string,
    title: string,
    status: ThreadSummary["status"],
    minutesAgo: number,
    pendingRequests = 0,
    agentSessionId: string | null = null,
  ): ThreadSummary => ({
    ...input.template,
    id,
    title,
    status,
    icon: null,
    color: null,
    parentThreadId: null,
    pendingRequests,
    unread: false,
    createdAt: at(minutesAgo),
    updatedAt: at(minutesAgo),
    askedAt: at(minutesAgo),
    doneAt: null,
    agentSessionId,
    externalWork: {
      sessionId: AgentSessionIdSchema.parse(slots[id]!.sessionId),
      connection: slots[id]!.connection,
      status: slots[id]!.status,
      endReason: slots[id]!.endReason,
    },
  });
  const calls =
    "const page = await tab('Shopping');\nawait page.click('Add to cart');\nawait page.click('Place order');";
  const request = RequestSchema.parse({
    agentOperation: {
      operationId: "aop_00000000-0000-4000-8000-000000000107",
      connectionId: grok.id,
      summary: `${shopping} · Studio Mac\nGrok wants to run a script in ${shopping}.`,
      calls,
      agentReason: input.long ? null : "Buy the $12 phone case you asked for.",
      target: profile(shopping),
      decisionFieldId: "operation-decision",
    },
    callId: `operation:aop_00000000-0000-4000-8000-000000000107:mock`,
    cancellationReason: null,
    createdAt: at(1),
    id: mockAgentOperationRequestId,
    kind: "person.question",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingAgentSessionId: sessions.waiting,
    originatingRunId: null,
    originatingThreadId: mockAgentWorkThreads.waiting,
    payload: { kind: "person.question" },
    presentation: {
      kind: "form",
      title: `Run a script in ${shopping}?`,
      detail: `${shopping} · Studio Mac\nGrok wants to run a script in ${shopping}.\n\nWhat it will run:\n${calls}${input.long ? "" : "\n\nThe agent's own reason (its words, not checked): Buy the $12 phone case you asked for."}`,
      fields: [
        {
          id: "operation-decision",
          prompt: "Allow this once?",
          choices: [
            { label: "Allow once", value: "allow" },
            { label: "Don't allow", value: "deny" },
          ],
          custom: false,
          multiSelect: false,
          secret: false,
        },
      ],
    },
    requestedBy: input.userId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
  return {
    threads: [
      task(
        mockAgentWorkThreads.working,
        "Find flights to Lisbon",
        "running",
        12,
        0,
        sessions.working,
      ),
      task(
        mockAgentWorkThreads.waiting,
        input.long
          ? "Buy the replacement phone case and a screen protector before the trip on Friday"
          : "Buy the phone case",
        "waiting",
        4,
        1,
        sessions.waiting,
      ),
      task(mockAgentWorkThreads.stopped, "Renew the parking permit", "idle", 90),
      task(mockAgentWorkThreads.ended, "Compare running shoes", "idle", 45),
    ],
    requests: { [mockAgentWorkThreads.waiting]: [request] },
    operations: Object.values(slots).flatMap(({ operations, connection }) =>
      (operations ?? []).map((operation) => ({ connectionId: connection.id, operation })),
    ),
  };
}
