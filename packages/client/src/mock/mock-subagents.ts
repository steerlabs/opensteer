import {
  createId,
  AgentEventViewSchema,
  ExecutionNodeIdSchema,
  AssignmentSummarySchema,
  AssignmentViewSchema,
  RequestSchema,
  SequenceSchema,
  type AgentEventView as AgentEvent,
  type AssignmentView,
} from "@opensteer/core";
import type { HostSnapshot, NodeEntry, RunEntry, TranscriptEntry } from "../host/client.js";

export function seedMockSubagents(snapshot: HostSnapshot): {
  snapshot: HostSnapshot;
  events: readonly AgentEvent[];
  assignment: AssignmentView;
} {
  const base =
    snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId) ?? snapshot.threads[0];
  if (!base || !snapshot.user) throw new Error("Subagents need a mock conversation.");
  const threadId = createId("thread");
  const runId = createId("run");
  const oldRunId = createId("run");
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 14, minute)).toISOString();
  const thread = {
    ...base,
    id: threadId,
    title: "Subagents everywhere",
    role: "conversation" as const,
    parentThreadId: null,
    status: "running" as const,
    pendingRequests: 1,
    createdAt: at(0),
    updatedAt: at(30),
    listed: true,
  };
  const run = (
    id: string,
    status: RunEntry["status"],
    start: number,
    end: number | null,
  ): RunEntry => ({
    id: `run:${id}`,
    kind: "run",
    runId: id,
    status,
    startedAt: at(start),
    createdAt: at(start),
    error: null,
    ...(end === null ? {} : { endedAt: at(end) }),
    replyMessageId: null,
  });
  const node = (title: string, minute: number, overrides: Partial<NodeEntry> = {}): NodeEntry => {
    const nodeId = createId("executionNode");
    return {
      id: `node:${nodeId}`,
      kind: "node",
      nodeKind: "subagent",
      nodeId,
      title,
      runId,
      status: "running",
      createdAt: at(minute),
      completedAt: null,
      model: "gpt-6.1-sol",
      effort: "high",
      originCallId: null,
      parentNodeId: null,
      phaseIndex: null,
      phases: [],
      prompt: `Please ${title.toLowerCase()}.`,
      result: null,
      progress: null,
      ...overrides,
    };
  };
  const finished = node("Inspect the contract", 0, {
    runId: oldRunId,
    status: "completed",
    completedAt: at(22),
    result: "Confirmed the event and pagination contract.",
  });
  const working = node("Trace the client", 23, {
    progress: "Checking reconnects and the history boundary",
  });
  const waiting = node("Review the experience", 24);
  const done = node("Research the reference", 25, {
    status: "completed",
    completedAt: at(28),
    result: "The reference groups adjacent helpers and keeps working cards visible.",
  });
  const child = node("Check the tool output", 26, {
    parentNodeId: working.nodeId,
    status: "completed",
    completedAt: at(27),
    result: "The streamed output matches the final result.",
  });
  const workflow = node("Verify every surface", 26, {
    nodeKind: "workflow",
    phases: ["Inspect", "Validate"],
  });
  const first = node("Inspect shared state", 26, {
    parentNodeId: workflow.nodeId,
    phaseIndex: 0,
    status: "completed",
    completedAt: at(27),
    result: "Shared state is ready.",
  });
  const second = node("Validate phone behavior", 28, {
    parentNodeId: workflow.nodeId,
    phaseIndex: 1,
    progress: "Opening the node transcript over a slow connection",
  });
  const task = node("Watch the build", 29, { nodeKind: "task", progress: "Waiting for the build" });
  const workerId = createId("thread");
  const workerRunId = createId("run");
  const worker = {
    ...thread,
    id: workerId,
    role: "work" as const,
    parentThreadId: threadId,
    title: "Review the release notes",
    pendingRequests: 0,
    status: "idle" as const,
  };
  const assignment = AssignmentViewSchema.parse({
    id: createId("delegation"),
    createdAt: at(25),
    updatedAt: at(29),
    finishedAt: at(29),
    initialInputMessageId: createId("message"),
    initialRunId: workerRunId,
    objective: "Review the release notes",
    origin: "run",
    parentAssignmentId: null,
    parentOccurrenceId: null,
    parentRunId: runId,
    parentThreadId: threadId,
    parentWatchActivationId: null,
    replyTarget: null,
    revision: 1,
    resultRunId: workerRunId,
    resultText: "Release notes reviewed; all surfaces are covered.",
    returnAttemptedAt: at(29),
    returnMessageId: createId("message"),
    returnReason: null,
    returnStatus: "delivered",
    status: "completed",
    workerThreadId: workerId,
  });
  const summary = AssignmentSummarySchema.parse({
    ...assignment,
    currentRunId: null,
    currentRunStatus: "completed",
    modelLabel: "gpt-6.1-sol",
    objectivePreview: assignment.objective,
    resultPreview: assignment.resultText,
    workerThread: {
      id: workerId,
      title: worker.title,
      environmentId: worker.environmentId,
      workspaceId: worker.workspaceId,
      pendingRequests: 0,
      status: "idle",
      icon: null,
    },
  });
  const request = RequestSchema.parse({
    id: createId("request"),
    kind: "harness.input",
    payload: { kind: "harness.input" },
    mode: "live",
    status: "pending",
    createdAt: at(25),
    callId: "experience-question",
    originatingNodeId: waiting.nodeId,
    originatingRunId: runId,
    originatingOccurrenceId: null,
    originatingThreadId: threadId,
    originatingWorkspaceId: thread.workspaceId,
    targetWorkspaceId: thread.workspaceId,
    requestedBy: snapshot.user.id,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    cancellationReason: null,
    presentation: {
      kind: "choice",
      title: "Which surface should I inspect first?",
      detail: "The shared model covers both layouts.",
      risk: "low",
      options: [
        { id: "phone", label: "Phone first", hint: "other" },
        { id: "web", label: "Web first", hint: "other" },
      ],
    },
  });
  const entries: TranscriptEntry[] = [
    run(oldRunId, "completed", 0, 22),
    finished,
    {
      id: createId("message"),
      kind: "message",
      messageKind: "assistant",
      author: { kind: "platform", cause: "assistant-message" },
      body: "The contract is ready. I am starting the implementation and review helpers.",
      createdAt: at(22),
      runId: oldRunId,
    },
    run(runId, "running", 23, null),
    working,
    waiting,
    done,
    {
      id: `assignment:${assignment.id}`,
      kind: "assignment",
      assignment: summary,
      createdAt: at(25),
      runId,
    },
    child,
    workflow,
    first,
    second,
    task,
  ];
  let sequence = 100;
  const events: AgentEvent[] = [];
  const emit = (event: Pick<AgentEvent, "type" | "data">, minute: number) => {
    events.push(
      AgentEventViewSchema.parse({
        ...event,
        createdAt: at(minute),
        environmentId: createId("environment"),
        eventId: createId("event"),
        runId,
        threadId,
        workspaceId: createId("workspace"),
        sequence: SequenceSchema.parse(String(++sequence)),
      }),
    );
  };
  for (const item of entries)
    if (item.kind === "node") {
      const detailNodeId = ExecutionNodeIdSchema.parse(item.nodeId);
      emit(
        {
          type: "node.message",
          data: { nodeId: detailNodeId, text: `I am working on: ${item.title}.` },
        },
        26,
      );
      emit(
        {
          type: "reasoning.completed",
          data: {
            nodeId: detailNodeId,
            blockId: `reasoning:${item.nodeId}`,
            text: "I will check the shared state and verify the behavior a person sees.",
          },
        },
        27,
      );
      emit(
        {
          type: "tool.started",
          data: {
            nodeId: detailNodeId,
            callId: `read:${item.nodeId}`,
            tool: { namespace: "functions", name: "read_file" },
            arguments: { path: "packages/client/src/host/transcript.ts" },
          },
        },
        27,
      );
      emit(
        {
          type: "tool.completed",
          data: {
            nodeId: detailNodeId,
            callId: `read:${item.nodeId}`,
            output: { text: "Read the transcript reducer." },
            isError: false,
          },
        },
        28,
      );
      if (item.result)
        emit({ type: "node.message", data: { nodeId: detailNodeId, text: item.result } }, 29);
    }
  return {
    assignment,
    events: events.map((event) => ({
      ...event,
      workspaceId: thread.workspaceId as AgentEvent["workspaceId"],
    })),
    snapshot: {
      ...snapshot,
      threads: [...snapshot.threads, thread, worker],
      assignments: { ...snapshot.assignments, [summary.id]: summary },
      runQueue: [
        ...snapshot.runQueue,
        { id: runId, threadId, runOrdinal: 1, createdAt: at(23), status: "running" },
      ],
      requests: { ...snapshot.requests, [threadId]: [request] },
      transcripts: {
        ...snapshot.transcripts,
        [threadId]: entries,
        [workerId]: [run(workerRunId, "completed", 25, 29)],
      },
    },
  };
}
