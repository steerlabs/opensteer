const fields: Readonly<Record<string, string>> = {
  originatingThreadId: "originatingTaskId",
  threadId: "taskId",
  parentThreadId: "parentTaskId",
  assignmentId: "delegationId",
  harnessInstanceId: "aiAccountId",
  nextBefore: "nextCursor",
  thread: "task",
  threads: "tasks",
  trigger: "automation",
  triggers: "automations",
  triggerId: "automationId",
  anchorThreadId: "taskId",
  createdByThreadId: "createdByTaskId",
  anchorThreadTitle: "taskTitle",
  createdByThreadTitle: "createdByTaskTitle",
  threadTitle: "taskTitle",
};
const opaque = new Set([
  "result",
  "payload",
  "source",
  "program",
  "text",
  "body",
  "content",
  "places",
  "place",
  "target",
]);
export function productToolOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(productToolOutput);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "environmentId" && key !== "environmentConnected")
      .map(([key, item]) => [fields[key] ?? key, opaque.has(key) ? item : productToolOutput(item)]),
  );
}
