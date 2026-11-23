import recorded from "./chat-parity.fixture.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { mutationIdempotencyKey } from "../host/index.js";
import {
  chatParityChat,
  chatParityProvider,
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
      // The provider the Home's messaging runtime reached when the script was recorded.
      messagingProvider: chatParityProvider,
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
      // A chat by the name the person sees it under, on its account, in the views just read.
      const chatOf = (account: string, label: string) =>
        current.connections.find(
          (row) => row.label === label && row.bridge?.accountName === account,
        );
      const connectionOf = (account: string) =>
        connectionIds.get(account) ?? `con_${crypto.randomUUID()}`;
      const key = () => mutationIdempotencyKey("parity");
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
              idempotencyKey: key(),
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
              connectionId: connectionOf(command.account) as never,
              status: command.status,
              idempotencyKey: key(),
            });
            answer = { ok: true };
          } else if (command.kind === "task.stop") {
            const task = chatOf(command.account, command.chat)?.bridge?.tasks?.find(
              ({ title }) => title === command.task,
            );
            await client.stopRun(task!.id);
            answer = { ok: true };
          } else if (command.kind === "connection.update") {
            const chat = chatOf(command.account, command.chat)!;
            const revision = chat.grantRevision ?? 1;
            const result = await client.dispatch({
              type: "connection.update",
              connectionId: chat.id,
              expectedRevision: command.revision === "current" ? revision : revision - 1,
              ...(command.accessMode !== undefined ? { accessMode: command.accessMode } : {}),
              ...(command.grant !== undefined ? { grant: command.grant } : {}),
              ...(command.label !== undefined ? { label: command.label } : {}),
              idempotencyKey: key(),
            } as never);
            answer = {
              ok: true,
              chat: chatParityChat(
                (result as { connection: Parameters<typeof chatParityChat>[0] }).connection,
              ),
            };
          } else if (command.kind === "connection.revoke" || command.kind === "connection.remove") {
            await client.dispatch({
              type: command.kind,
              connectionId: chatOf(command.account, command.chat)!.id,
              idempotencyKey: key(),
            } as never);
            answer = { ok: true };
          } else if (command.kind === "me.link") {
            await client.dispatch({
              type: "channel.me.link",
              accountId: (accountIds.get(command.account) ?? `cha_${crypto.randomUUID()}`) as never,
              idempotencyKey: key(),
            });
            answer = { ok: true };
          } else if (command.kind === "account.check") {
            const checked = await client.rpc["channel.connection.check"]({
              connectionId: connectionOf(command.account) as never,
            });
            answer = checked.ok
              ? { ok: true }
              : {
                  ok: false,
                  code: checked.error.code,
                  reason: checked.error.reason ?? null,
                  message: checked.error.message,
                };
          } else if (command.kind === "account.create") {
            await client.dispatch({
              type: "channel.connection.create",
              provider: command.provider,
              routingMode: "dedicated",
              credentials: { botToken: `xoxb-${command.token}`, appToken: "xapp-parity" },
              idempotencyKey: key(),
            });
            answer = { ok: true };
          } else if (command.kind === "account.computer.create") {
            await client.dispatch({
              type: "channel.connection.computer.create",
              provider: command.provider,
              runnerId: `rnr_${crypto.randomUUID()}` as never,
              idempotencyKey: key(),
            });
            answer = { ok: true };
          } else {
            await client.dispatch({
              type: "channel.connection.credentials.replace",
              connectionId: connectionOf(command.account) as never,
              credentials: { botToken: `xoxb-${command.token}`, appToken: "xapp-parity" },
              idempotencyKey: key(),
            });
            answer = { ok: true };
          }
        } catch (error) {
          answer = chatParityRefusal(error);
        }
        current = await read();
        const views = chatParityViews(current.channels, current.connections);
        if (step.notComparable) {
          // What can be compared is: the answer's shape (done or refused) and the views after.
          expect({ step: step.name, ok: answer.ok, views }).toEqual({
            step: step.name,
            ok: step.answer.ok,
            views: step.views,
          });
          continue;
        }
        expect({ step: step.name, answer, views }).toEqual({
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
