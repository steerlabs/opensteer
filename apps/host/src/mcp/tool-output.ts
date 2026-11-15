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
  "link",
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
const dropped = new Set(["environmentId", "environmentConnected"]);
/** Domain field names a tool output never carries, because the projection renames or drops them. */
export const projectedAwayFields: ReadonlySet<string> = new Set([
  ...Object.keys(fields),
  ...dropped,
]);
/** Fields whose values pass through untouched. */
export const opaqueToolFields: ReadonlySet<string> = opaque;
export function productToolOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(productToolOutput);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !dropped.has(key))
      .map(([key, item]) => [fields[key] ?? key, opaque.has(key) ? item : productToolOutput(item)]),
  );
}
