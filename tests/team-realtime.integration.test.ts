import { expect, it } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { startTeamSystem, teamCondition } from "./team-system.test-support.js";

it("keeps the channel and thread live together", async () => {
  const team = await startTeamSystem();
  try {
    const owner = await team.setup(),
      session = await team.session(owner, "Regression device");
    console.info("realtime regression: load");
    await session.client.load();
    const channelId = createId("teamChannel");
    console.info("realtime regression: create");
    const created = await session.rpc["commands.dispatch"]({
      type: "team.channel.create",
      id: channelId,
      kind: "public",
      name: "support",
      peopleOnly: false,
      access: [{ subject: { kind: "person", userId: owner }, level: "post", manage: true }],
    });
    expect(created.ok).toBe(true);
    console.info("realtime regression: select channel");
    session.client.selectChannel(channelId);
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().channel?.channel ?? undefined,
      "Channel did not open",
    );
    const send = async (text: string, root: string | null = null) => {
      const result = await session.rpc["commands.dispatch"]({
        type: "team.message.send",
        channelId,
        threadRootId: root,
        clientMessageId: crypto.randomUUID(),
        bodyMarkdown: text,
        mentions: [],
        attachmentIds: [],
      });
      if (!result.ok || result.data.type !== "team.message.send")
        throw new Error(JSON.stringify(result));
      return result.data.message;
    };
    console.info("realtime regression: root");
    const root = await send("Root");
    session.client.selectThread(channelId, root.id);
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().thread?.channel ?? undefined,
      "Thread did not open",
    );
    console.info("realtime regression: later");
    const later = await send("Channel remains live");
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().channel?.messages.find((row) => row.id === later.id),
      "Opening a thread stopped live channel delivery",
    );
    console.info("realtime regression: reply");
    const reply = await send("Thread remains live", root.id);
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().thread?.messages.find((row) => row.id === reply.id),
      "Channel update stopped thread delivery",
    );
    await teamCondition(
      session.client,
      () =>
        session.client.getSnapshot().channel?.messages.find((row) => row.id === root.id)
          ?.replySummary.count === 1
          ? true
          : undefined,
      "Thread reply summary never reached the channel",
    );
  } catch (error) {
    console.info("realtime regression failed", error);
    throw error;
  } finally {
    await team.close();
  }
});
