import {
  AgentEventViewSchema,
  ThreadViewSchema,
  OpensteerError,
  type AgentEventView,
  type RequestId,
  type ThreadId,
  type ThreadRequestWaits,
  type ThreadRequestOutcome,
  type Thread,
  type UserId,
} from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import type { Transaction } from "kysely";
import { ProjectRequestStore, type ProjectRequestViewFacts } from "./project-request-store.js";

export async function projectThreadViews(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  threads: readonly Thread[],
) {
  const facts = await new ProjectRequestStore(transaction).threadFacts({
    userId,
    threadIds: [...new Set(threads.map((thread) => thread.id))],
  });
  return threads.map((thread) => {
    const display = facts.get(thread.id);
    if (!display)
      throw new OpensteerError({ code: "forbidden", message: "Project Thread is unavailable" });
    return ThreadViewSchema.parse({ ...thread, ...display });
  });
}

export async function projectClientEventViews(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
  events: readonly AgentEventView[],
): Promise<AgentEventView[]> {
  const requests = new ProjectRequestStore(transaction);
  const requestId = (event: AgentEventView): RequestId | null => {
    switch (event.type) {
      case "request.cancelled":
        return event.data.requestId;
      case "request.opened":
      case "request.updated":
      case "request.resolved":
        return event.data.request.id;
      default:
        return null;
    }
  };
  const ids = [...new Set(events.flatMap((event) => requestId(event) ?? []))];
  const displays = new Map<RequestId, ProjectRequestViewFacts>();
  for (let index = 0; index < ids.length; index += 100)
    for (const [id, facts] of await requests.viewFacts(transaction, {
      userId,
      requestIds: ids.slice(index, index + 100),
    }))
      displays.set(id, facts);
  const threads = events.flatMap((event) =>
    event.type === "thread.created" ||
    event.type === "thread.listed" ||
    event.type === "thread.execution-updated"
      ? [event.data.thread]
      : [],
  );
  const threadIds = [...new Set(threads.map((thread) => thread.id))];
  const threadFacts = new Map<
    ThreadId,
    {
      readonly requestWaits: ThreadRequestWaits;
      readonly requestOutcomes: readonly ThreadRequestOutcome[];
    }
  >();
  for (let index = 0; index < threadIds.length; index += 100)
    for (const [id, facts] of await requests.threadFacts({
      userId,
      threadIds: threadIds.slice(index, index + 100),
    }))
      threadFacts.set(id, facts);
  return events.flatMap((event) => {
    const id = requestId(event);
    if (id) {
      const display = displays.get(id);
      if (!display) return [];
      if (event.type === "request.cancelled")
        return [
          AgentEventViewSchema.parse({
            ...event,
            data: {
              ...event.data,
              ...(display.cancelledFor ? { cancelledFor: display.cancelledFor } : {}),
            },
          }),
        ];
      if (
        event.type === "request.opened" ||
        event.type === "request.updated" ||
        event.type === "request.resolved"
      )
        return [
          AgentEventViewSchema.parse({
            ...event,
            data: { ...event.data, request: { ...event.data.request, ...display } },
          }),
        ];
    }
    if (
      event.type === "thread.created" ||
      event.type === "thread.listed" ||
      event.type === "thread.execution-updated"
    ) {
      const display = threadFacts.get(event.data.thread.id);
      if (!display)
        throw new OpensteerError({ code: "forbidden", message: "Project Thread is unavailable" });
      return [
        AgentEventViewSchema.parse({
          ...event,
          data: { ...event.data, thread: { ...event.data.thread, ...display } },
        }),
      ];
    }
    return [AgentEventViewSchema.parse(event)];
  });
}
