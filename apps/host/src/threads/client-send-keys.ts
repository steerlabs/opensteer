import type { AgentEventView, MessageId, MessageView } from "@opensteer/core";

type ReadKeys = (ids: readonly MessageId[]) => Promise<ReadonlyMap<string, string>>;

function canCarryKey(message: MessageView): boolean {
  return message.author.kind === "human" && message.kind === "input";
}

function withKey(message: MessageView, keys: ReadonlyMap<string, string>): MessageView {
  // This optional field is admitted only by the viewer-scoped database read.
  const { clientSendKey: _discard, ...value } = message;
  const key = canCarryKey(message) ? keys.get(message.id) : undefined;
  return key ? { ...value, clientSendKey: key } : value;
}

export async function withClientSendKeys(
  messages: readonly MessageView[],
  read: ReadKeys,
): Promise<MessageView[]> {
  const keys = await read(messages.filter(canCarryKey).map((message) => message.id));
  return messages.map((message) => withKey(message, keys));
}

function carriesMessage(event: AgentEventView) {
  return (
    event.type === "message.created" ||
    event.type === "message.placed" ||
    event.type === "message.updated"
  );
}

export async function withEventClientSendKeys(
  events: readonly AgentEventView[],
  read: ReadKeys,
): Promise<AgentEventView[]> {
  const ids = events
    .filter(carriesMessage)
    .map((event) => event.data.message)
    .filter(canCarryKey)
    .map((message) => message.id);
  const keys = await read([...new Set(ids)]);
  return events.map((event) => {
    if (carriesMessage(event)) {
      const message = withKey(event.data.message, keys);
      if (event.type === "message.created") return { ...event, data: { ...event.data, message } };
      if (event.type === "message.placed") return { ...event, data: { ...event.data, message } };
      return { ...event, data: { ...event.data, message } };
    }
    return event;
  });
}
