import type { NormalizedChannelEvent } from "@opensteer/channel-core";
import { describe, expect, it, vi } from "vitest";
import { mentionedUserIds, normalizeSlackEvent } from "./events.js";

const botUserId = "U0BOT";

describe("normalizeSlackEvent", () => {
  it("recognises the labelled mention form and Enterprise Grid ids", async () => {
    expect(mentionedUserIds("hi <@U0BOT|opensteer> and <@W123ABC>")).toEqual(["U0BOT", "W123ABC"]);
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        text: "<@U0BOT|opensteer> go",
        ts: "1.1",
      }),
    ).resolves.toMatchObject({ content: [{ text: "go", type: "text" }], trigger: "mention" });
  });

  it("keeps the Slack thread of a direct message when one is open", async () => {
    await expect(
      normalize({
        channel: "D1",
        channel_type: "im",
        text: "more",
        thread_ts: "1786320000.000100",
        ts: "1786320001.000200",
      }),
    ).resolves.toMatchObject({
      conversation: { externalThreadId: "1786320000.000100", type: "dm" },
      trigger: "direct-message",
    });
  });

  it("requires a mention in a group direct message and ignores channel chatter", async () => {
    await expect(
      normalize({ channel: "G1", channel_type: "mpim", text: "just talking", ts: "1.1" }),
    ).resolves.toBeNull();
    await expect(
      normalize({ channel: "G1", channel_type: "mpim", text: "<@U0BOT> hi", ts: "1.1" }),
    ).resolves.toMatchObject({ conversation: { type: "group" }, trigger: "mention" });
    await expect(
      normalize({ channel: "C1", channel_type: "channel", text: "ordinary chatter", ts: "1.1" }),
    ).resolves.toBeNull();
  });

  it("separates a private channel from a group direct message by channel_type alone", async () => {
    await expect(
      normalize({ channel: "G1", channel_type: "group", text: "<@U0BOT> hi", ts: "1.1" }),
    ).resolves.toMatchObject({ conversation: { type: "channel" } });
  });

  it("reads an unaddressed thread reply as a follow-up and an addressed one as new work", async () => {
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        text: "continue",
        thread_ts: "1786320000.000100",
        ts: "1786320001.000200",
      }),
    ).resolves.toMatchObject({
      conversation: { externalThreadId: "1786320000.000100" },
      trigger: "conversation-followup",
    });
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        text: "<@U0BOT> new question",
        thread_ts: "1786320000.000100",
        ts: "1786320002.000300",
      }),
    ).resolves.toMatchObject({
      conversation: { externalThreadId: "1786320000.000100" },
      trigger: "mention",
    });
  });

  it("never reacts to its own messages or to any other app's", async () => {
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        text: "<@U0BOT> hi",
        ts: "1.1",
        user: botUserId,
      }),
    ).resolves.toBeNull();
    await expect(
      normalize({
        bot_id: "B1",
        channel: "C1",
        channel_type: "channel",
        text: "<@U0BOT> hi",
        ts: "1.1",
      }),
    ).resolves.toBeNull();
  });

  it("drops edits, deletions, hidden messages and non-message events", async () => {
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        subtype: "message_changed",
        text: "<@U0BOT> hi",
        ts: "1.1",
      }),
    ).resolves.toBeNull();
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        subtype: "message_deleted",
        text: "<@U0BOT> hi",
        ts: "1.1",
      }),
    ).resolves.toBeNull();
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        hidden: true,
        text: "<@U0BOT> hi",
        ts: "1.1",
      }),
    ).resolves.toBeNull();
    // `app_mention` is no longer subscribed to; an older install must not make
    // the same message arrive twice.
    await expect(
      normalize({ channel: "C1", text: "<@U0BOT> hi", ts: "1.1", type: "app_mention" }),
    ).resolves.toBeNull();
  });

  it("accepts a shared file and a thread broadcast as ordinary messages", async () => {
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        subtype: "file_share",
        text: "<@U0BOT> look",
        ts: "1.1",
      }),
    ).resolves.toMatchObject({ trigger: "mention" });
    await expect(
      normalize({
        channel: "C1",
        channel_type: "channel",
        subtype: "thread_broadcast",
        text: "also here",
        thread_ts: "1.0",
        ts: "1.1",
      }),
    ).resolves.toMatchObject({ trigger: "conversation-followup" });
  });

  it("keeps a message that says nothing but the mention readable", async () => {
    await expect(
      normalize({ channel: "C1", channel_type: "channel", text: "<@U0BOT>", ts: "1.1" }),
    ).resolves.toMatchObject({ content: [{ text: "(No text content)", type: "text" }] });
  });

  it("falls back to the user id when Slack will not name the person", async () => {
    const event = await normalizeSlackEvent(
      payload({ channel: "D1", channel_type: "im", text: "hi", ts: "1.1" }),
      {
        botUserId,
        displayName: async (externalUserId) => externalUserId,
        receivedAt: new Date("2026-08-10T00:00:00.000Z"),
      },
    );
    expect(event?.actor).toEqual({ displayName: "U1", externalUserId: "U1" });
  });
});

function payload(event: Record<string, unknown>): unknown {
  return {
    api_app_id: "A1",
    event: { type: "message", user: "U1", ...event },
    event_id: "Ev1",
    event_time: 1_786_320_000,
    team_id: "T1",
    type: "event_callback",
  };
}

async function normalize(event: Record<string, unknown>): Promise<NormalizedChannelEvent | null> {
  return normalizeSlackEvent(payload(event), {
    botUserId,
    displayName: vi.fn(async () => "Ada"),
    receivedAt: new Date("2026-08-10T00:00:00.000Z"),
  });
}
