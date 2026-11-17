import type { AgentEventView, MessageId, MessageView } from "@opensteer/core";

type ReadKeys = (ids: readonly MessageId[]) => Promise<ReadonlyMap<string, string>>;

export async function withClientSendKeys(
  messages: readonly MessageView[],
  read: ReadKeys,
): Promise<MessageView[]> {
  const keys = await read(
    messages
      .filter((message) => message.author.kind === "human" && message.kind === "input")
      .map((message) => message.id),
  );
  return messages.map((message) => {
    // This optional field is admitted only by the viewer-scoped database read.
    const { clientSendKey: _discard, ...value } = message;
    const key = keys.get(message.id);
    return key ? { ...value, clientSendKey: key } : value;
  });
}

export async function withEventClientSendKeys(
  events: readonly AgentEventView[],
  read: ReadKeys,
): Promise<AgentEventView[]> {
  const carriesMessage = (event: AgentEventView) =>
    event.type === "message.created" ||
    event.type === "message.placed" ||
    event.type === "message.updated";
  const messages = events.flatMap((event) => (carriesMessage(event) ? [event.data.message] : []));
  const enriched = await withClientSendKeys(messages, read);
  const byId = new Map(enriched.map((message) => [message.id, message]));
  return events.map((event) => {
    if (event.type === "message.created")
      return { ...event, data: { ...event.data, message: byId.get(event.data.message.id)! } };
    if (event.type === "message.placed")
      return { ...event, data: { ...event.data, message: byId.get(event.data.message.id)! } };
    if (event.type === "message.updated")
      return { ...event, data: { ...event.data, message: byId.get(event.data.message.id)! } };
    return event;
  });
}
