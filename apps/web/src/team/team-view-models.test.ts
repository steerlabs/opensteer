import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MockTeamHost, mockTeamChannelId } from "@opensteer/client/team";
import { messageView, type TeamWords } from "./team-view-models.js";

describe("Host-authoritative message moderation", () => {
  it("allows a non-admin channel manager, and denies a team admin in a non-managed DM", () => {
    const host = new MockTeamHost();
    try {
      const other = createId("user");
      host.members.push({ ...host.bootstrap.member, userId: other, role: "member" });
      const message = host.post({
        channelId: mockTeamChannelId,
        authorUserId: other,
        bodyMarkdown: "Another person's message",
      });
      const words: TeamWords = {
        viewerUserId: host.userId,
        members: new Map([[host.userId, { ...host.bootstrap.member, role: "member" }]]),
        linkOnline: new Map(),
        previews: new Map(),
        managedChannels: new Set([mockTeamChannelId]),
      };
      expect(messageView(words, message).canDelete).toBe(true);
      const admin: TeamWords = {
        ...words,
        members: new Map([[host.userId, { ...host.bootstrap.member, role: "admin" }]]),
        managedChannels: new Set(),
      };
      expect(messageView(admin, message).canDelete).toBe(false);
      expect(messageView(admin, message).canEdit).toBe(false);
    } finally {
      host.dispose();
    }
  });
});
