import { z } from "zod";
import {
  DeploymentIdSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  TeamSourceSchema,
  TeamAskOutcomeSchema,
} from "@opensteer/core";
import {
  TeamMarkdownSchema,
  PersonalTeamLinkSchema,
  TeamChannelsResultSchema,
  TeamReadResultSchema,
  TeamMessagePageSchema,
  TeamSearchInputSchema,
  TeamSearchPageSchema,
  agentToolPayloadMaxSerializedBytes,
} from "@opensteer/protocol";
import { CursorSchema, OperationKeySchema } from "./inputs.js";
import { defineAgentTool } from "../registry.js";

export const opensteer_team_read = defineAgentTool({
  name: "opensteer_team_read",
  title: "Read team context",
  description:
    "List linked teams with {}, list readable channels with teamId, read messages with channelId, and page with cursor. People-only content is unavailable. Use opensteer_team_file_download for files.",
  input: z
    .strictObject({
      teamId: DeploymentIdSchema.optional(),
      channelId: TeamChannelIdSchema.optional(),
      threadId: TeamMessageIdSchema.optional(),
      cursor: CursorSchema.optional(),
    })
    .refine((i) => !i.threadId || !!i.channelId, "threadId requires channelId"),
  output: z
    .union([
      z.strictObject({
        teams: z
          .array(PersonalTeamLinkSchema.pick({ teamId: true, teamName: true, state: true }))
          .max(100),
      }),
      TeamChannelsResultSchema.omit({ nextAfter: true }).extend({
        nextCursor: TeamChannelsResultSchema.shape.nextAfter,
      }),
      TeamReadResultSchema.extend({
        page: TeamMessagePageSchema.extend({ nextCursor: TeamMessageIdSchema.nullable() }),
      }),
      z.strictObject({ path: z.string().min(1).max(4096), source: TeamSourceSchema }),
    ])
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        agentToolPayloadMaxSerializedBytes,
      "Team context exceeds the agent output byte limit",
    ),
  access: "read",
  team: true,
  callers: ["run"],
});
export const opensteer_team_search = defineAgentTool({
  name: "opensteer_team_search",
  title: "Search the team",
  description:
    "Search messages in channels the owner may read as an agent. Results carry their own source and audience, which may differ from the asking channel. People-only content is excluded. Keep query and filters when paging with cursor.",
  input: TeamSearchInputSchema.omit({ before: true }).extend({
    teamId: DeploymentIdSchema.optional(),
    cursor: CursorSchema.optional(),
  }),
  output: TeamSearchPageSchema,
  access: "read",
  team: true,
  callers: ["run"],
});
export const opensteer_team_post = defineAgentTool({
  name: "opensteer_team_post",
  title: "Post to a team channel",
  description:
    "Post as the owner's agent to an explicit channel and optional thread. teamId may be omitted when exactly one team is linked. Consider the destination audience before sharing private material. Posting to this Run's reply target claims its automatic reply; other posts are independent. Never repeat an uncertain post to recover delivery.",
  input: z.strictObject({
    teamId: DeploymentIdSchema.optional(),
    channelId: TeamChannelIdSchema,
    threadId: TeamMessageIdSchema.optional(),
    operationKey: OperationKeySchema.optional(),
    bodyMarkdown: TeamMarkdownSchema,
    attachmentPaths: z.array(z.string().min(1).max(4096)).max(10).default([]),
  }),
  output: z.strictObject({
    messageId: TeamMessageIdSchema,
    source: TeamSourceSchema,
    askOutcomes: z.array(TeamAskOutcomeSchema).max(21).optional(),
  }),
  access: "write",
  team: true,
  callers: ["run"],
});

export const opensteer_team_file_download = defineAgentTool({
  name: "opensteer_team_file_download",
  title: "Download a team file",
  description: "Download an authorized file from a linked team and return its local path.",
  input: z.strictObject({ teamId: DeploymentIdSchema.optional(), fileId: TeamBlobIdSchema }),
  output: z.strictObject({ path: z.string().min(1).max(4096), source: TeamSourceSchema }),
  access: "read",
  team: true,
  callers: ["run"] as const,
});
