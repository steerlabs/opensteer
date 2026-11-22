import recorded from "./chat-parity.fixture.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { mutationIdempotencyKey } from "../host/index.js";
import {
  chatParityChat,
  chatParityRefusal,
  chatParityViews,
  type ChatParityAnswer,
  type ChatParityRecord,
} from "./chat-parity.js";
import { MockHostClient } from "./mock-host-client.js";

/**
 * The preview Home replays the script a real Home answered (`chat-parity.integration.test.ts`
 * in apps/host recorded it), from the same starting point, and must give the same answers and
 * leave the same views. A difference here is a preview kinder or harsher than the Home.
 */
const record = recorded as unknown as ChatParityRecord;

describe("the preview Home answers as the Home does", () => {
  it("starts where the Home started, and answers every step of the script as it did", async () => {
    // The Home's person is the preview's person.
    const probe = new MockHostClient({ latencyMs: 0 });
    const person = probe.getSnapshot().user!.id;
    probe.dispose();
    const client = new MockHostClient({
      latencyMs: 0,
      channels: record.seed.channels,
      connections: record.seed.connections.map((row) => ({ ...row, userId: person })),
    });
    try {
      const read = async () => {
        const channels = await client.rpc["channels.get"]({});
        const connections = await client.rpc["connections.list"]({ includeRevoked: true });
        if (!channels.ok || !connections.ok) throw new Error("The preview could not be read");
        return { channels: channels.data, connections: connections.data.connections };
      };
      let current = await read();
      expect(chatParityViews(current.channels, current.connections)).toEqual(record.start);
      const accountIds = new Map(current.channels.accounts.map((row) => [row.displayName, row.id]));
      const connectionIds = new Map(
        current.channels.accounts.map((row) => [row.displayName, row.connectionId]),
      );
      for (const step of record.steps) {
        const command = step.command;
        let answer: ChatParityAnswer;
        try {
          if (command.kind === "chat.create") {
            const made = await client.dispatch({
              type: "channel.chat.create",
              accountId: (accountIds.get(command.account) ?? `cha_${crypto.randomUUID()}`) as never,
              conversation: command.conversation,
              senders: command.senders,
              accessMode: command.accessMode,
              grant: command.grant,
              idempotencyKey: mutationIdempotencyKey("parity"),
            });
            answer = {
              ok: true,
              chat: chatParityChat(
                (made as { connection: Parameters<typeof chatParityChat>[0] }).connection,
              ),
            };
          } else if (command.kind === "account.status") {
            await client.dispatch({
              type: "channel.connection.status.set",
              connectionId: connectionIds.get(command.account)! as never,
              status: command.status,
              idempotencyKey: mutationIdempotencyKey("parity"),
            });
            answer = { ok: true };
          } else {
            const chat = current.connections.find(
              ({ label, bridge }) =>
                label === command.chat && bridge?.accountName === command.account,
            )!;
            const task = chat.bridge?.tasks?.find(({ title }) => title === command.task);
            await client.stopRun(task!.id);
            answer = { ok: true };
          }
        } catch (error) {
          answer = chatParityRefusal(error);
        }
        current = await read();
        expect({
          step: step.name,
          answer,
          views: chatParityViews(current.channels, current.connections),
        }).toEqual({
          step: step.name,
          answer: step.answer,
          views: step.views,
        });
      }
    } finally {
      client.dispose();
    }
  });
});
