import type { AgentEventView } from "@opensteer/core";
import type { HostToClientMessage } from "./client.js";
import type { NeedsYouPage } from "./needs-you.js";

/**
 * The personal API version whose readers know `person.question` Requests. An
 * older app would refuse the whole Needs you page or realtime frame that
 * carried one, so a Host serves it those without them; it can't answer one
 * anyway, and its newer devices can.
 */
export const personQuestionApiVersion = 59;

const readsPersonQuestions = (apiVersion: number) => apiVersion >= personQuestionApiVersion;

function isPersonQuestionEvent(event: AgentEventView): boolean {
  return (
    (event.type === "request.opened" ||
      event.type === "request.updated" ||
      event.type === "request.resolved") &&
    event.data.request.kind === "person.question"
  );
}

export function projectNeedsYouPage(page: NeedsYouPage, apiVersion: number): NeedsYouPage {
  if (readsPersonQuestions(apiVersion)) return page;
  return {
    ...page,
    entries: page.entries.filter(
      (entry) => entry.kind !== "request" || entry.request.kind !== "person.question",
    ),
  };
}

export function projectHostMessage<Message extends HostToClientMessage>(
  message: Message,
  apiVersion: number,
): Message {
  if (readsPersonQuestions(apiVersion)) return message;
  if (message.type === "host.events")
    return { ...message, events: message.events.filter((event) => !isPersonQuestionEvent(event)) };
  if (message.type === "host.snapshot")
    return {
      ...message,
      snapshot: {
        ...message.snapshot,
        needsYou: projectNeedsYouPage(message.snapshot.needsYou, apiVersion),
      },
    };
  return message;
}
