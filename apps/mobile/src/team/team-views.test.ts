import { createId, TeamMessageIdSchema, UserIdSchema, type UserId } from "@opensteer/core";
import { expect, it } from "vitest";
import { ownReplyInView } from "./team-views.js";

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
