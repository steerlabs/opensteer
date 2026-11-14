import { createId, TeamMessageIdSchema, UserIdSchema, type UserId } from "@opensteer/core";
import type { NeedsYouPage, TeamAgentRequest, TeamMessage } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { messageView, ownReplyInView } from "./team-views.js";

const me = UserIdSchema.parse("usr_00000000-0000-4000-8000-0000000000aa");
const other = createId("user");
const row = (id: string, authorKind: "human" | "agent", authorUserId: UserId) => ({
  id: TeamMessageIdSchema.parse(id),
  authorKind,
  authorUserId,
});

it("reads each reply of the reader's agent as it comes into view, never one off screen", () => {
  const thread = [row("10", "human", me), row("11", "agent", me), row("12", "agent", other)];
  // The first reply is on screen.
  expect(ownReplyInView(thread, me, "10", new Set(["10", "11", "12"]))).toBe("11");
  // A second reply arrives while the thread stays open: it is a new reply to read.
  const later = [...thread, row("13", "human", other), row("14", "agent", me)];
  expect(ownReplyInView(later, me, "10", new Set(["12", "13", "14"]))).toBe("14");
  // Scrolled away from it, nothing is read; the root and other people's agents never count.
  expect(ownReplyInView(later, me, "10", new Set(["10", "12", "13"]))).toBeNull();
  expect(ownReplyInView([row("20", "agent", me)], me, "20", new Set(["20"]))).toBeNull();
});

it("gives an ask's owner the answer in chat at the version their task holds, and no one else", () => {
  const teamId = createId("deployment");
  const threadId = createId("thread");
  const asked = {
    attachments: [],
    authorKind: "human",
    authorUserId: other,
    bodyMarkdown: "@Tim's agent can you check what's on your machine",
    changeSeq: "1",
    createdAt: "2026-11-14T19:28:00.000Z",
    deletedAt: null,
    editedAt: null,
    id: TeamMessageIdSchema.parse("30"),
    mentions: [],
    pinned: false,
    requests: [],
  } as unknown as TeamMessage;
  const waiting = {
    askRefusal: null,
    changeSeq: "5",
    id: createId("teamAgentRequest"),
    kind: "ask",
    ownerUserId: me,
    pendingRemote: false,
    replyMessageId: null,
    state: "awaiting_approval",
    triggerMessageId: asked.id,
  } as unknown as TeamAgentRequest;
  const needsYou = {
    count: 1,
    entries: [
      {
        kind: "team-ask",
        requestId: waiting.id,
        task: { messageId: createId("message"), revision: 0, threadId },
        teamId,
      },
    ],
    window: { hasMore: false },
  } as unknown as NeedsYouPage;
  const controls = (viewerId: string, requests: readonly TeamAgentRequest[]) =>
    messageView(asked, {
      asks: { needsYou, teamId },
      inThread: true,
      members: new Map(),
      previews: new Map(),
      previous: null,
      requests,
      viewerId,
    }).askStatuses?.map((status) => status.control);
  const settled = { ...waiting, changeSeq: "6", state: "working" } as unknown as TeamAgentRequest;
  expect(controls(me, [waiting])).toEqual([
    { expectedRevision: 0, kind: "decide", requestId: waiting.id, teamId, threadId },
  ]);
  // Answered on another device: the newer version of the request is the one that counts.
  expect(controls(me, [waiting, settled])).toEqual([{ kind: "none" }]);
  expect(controls(other, [waiting])).toEqual([{ kind: "none" }]);
});
