import { expect, it } from "vitest";
import { ownReplyInView } from "./team-views.js";

const me = "usr_00000000-0000-4000-8000-0000000000aa";
const row = (id: string, authorKind: "human" | "agent", authorUserId: string) => ({
  id,
  authorKind,
  authorUserId,
});

it("reads each reply of the reader's agent as it comes into view, never one off screen", () => {
  const thread = [row("10", "human", me), row("11", "agent", me), row("12", "agent", "usr_other")];
  // The first reply is on screen.
  expect(ownReplyInView(thread, me, "10", new Set(["10", "11", "12"]))).toBe("11");
  // A second reply arrives while the thread stays open: it is a new reply to read.
  const later = [...thread, row("13", "human", "usr_other"), row("14", "agent", me)];
  expect(ownReplyInView(later, me, "10", new Set(["12", "13", "14"]))).toBe("14");
  // Scrolled away from it, nothing is read; the root and other people's agents never count.
  expect(ownReplyInView(later, me, "10", new Set(["10", "12", "13"]))).toBeNull();
  expect(ownReplyInView([row("20", "agent", me)], me, "20", new Set(["20"]))).toBeNull();
});
