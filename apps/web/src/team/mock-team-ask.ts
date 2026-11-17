import type { MockTeamHost } from "@opensteer/client/team";
import { TeamAgentRequestIdSchema, UserIdSchema } from "@opensteer/core";
import {
  NeedsYouTeamAskEntrySchema,
  TeamAgentRequestSchema,
  TeamMemberSchema,
  type NeedsYouTeamAskEntry,
} from "@opensteer/protocol";

/**
 * `?mock-team`'s one ask: a teammate mentions the viewer's agent in #general,
 * so the channel shows the owner's answer under it and the personal mock
 * admits the same ask into a task, as a Host would on arrival.
 */
export function seedMockTeamAsk(team: MockTeamHost): NeedsYouTeamAskEntry {
  const viewer = team.bootstrap.member;
  const asker = TeamMemberSchema.parse({
    userId: UserIdSchema.parse("usr_00000000-0000-4000-8000-0000000000a2"),
    displayName: "Sam Rivera",
    handle: "sam",
    image: null,
    role: "member",
    state: "active",
    generation: "1",
    joinedAt: viewer.joinedAt,
  });
  team.members.push(asker);
  const channel = [...team.channels.values()][0]!;
  const createdAt = new Date(Date.now() - 4 * 60_000).toISOString();
  const bodyMarkdown = `@${viewer.handle}-agent can you check what’s still open on the launch checklist?`;
  const trigger = team.post({
    authorUserId: asker.userId,
    bodyMarkdown,
    channelId: channel.id,
    createdAt,
    mentions: [{ kind: "agent", userId: viewer.userId }],
  });
  const consentExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const request = team.setRequest(
    TeamAgentRequestSchema.parse({
      acceptedAt: null,
      changeSeq: trigger.changeSeq,
      channelId: channel.id,
      consentExpiresAt,
      createdAt,
      expiresAt: null,
      failureCode: null,
      finishedAt: null,
      id: TeamAgentRequestIdSchema.parse("tar_00000000-0000-4000-8000-0000000000a1"),
      kind: "ask",
      ownerUserId: viewer.userId,
      replyMessageId: null,
      state: "awaiting_approval",
      steps: [],
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    }),
  );
  return NeedsYouTeamAskEntrySchema.parse({
    consentExpiresAt,
    createdAt,
    kind: "team-ask",
    presentation: {
      asker: { actor: "human", displayName: asker.displayName, teamUserId: asker.userId },
      attachments: [],
      audience: {
        channelKind: channel.kind,
        channelName: channel.name,
        memberCount: team.members.length,
        peopleOnly: channel.peopleOnly,
        teamName: team.bootstrap.teamName,
      },
      bodyMarkdown,
      destination: { channelId: channel.id, teamId: team.teamId, threadRootId: trigger.id },
    },
    requestId: request.id,
    teamId: team.teamId,
  });
}
