import { z } from "zod";
import {
  IsoDateTimeSchema,
  KnowledgeTopicIdSchema,
  TeamChannelIdSchema,
  TeamSourceSchema,
  UserIdSchema,
  SequenceSchema,
} from "@opensteer/core";
import { TeamTopicCanSchema } from "./team-access.js";

export const TeamTopicSchema = z.strictObject({
  id: KnowledgeTopicIdSchema,
  name: z.string().trim().min(1).max(160),
  originChannelId: TeamChannelIdSchema.nullable(),
  peopleOnly: z.boolean(),
  archivedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  can: TeamTopicCanSchema,
});
export type TeamTopic = z.infer<typeof TeamTopicSchema>;
export const TeamFactInputSchema = z.strictObject({
  topicId: KnowledgeTopicIdSchema,
  thing: z.string().min(1).max(512),
  property: z.string().min(1).max(512),
  value: z.json(),
  replacesId: SequenceSchema.nullable(),
});
export const TeamFactSchema = TeamFactInputSchema.extend({
  id: SequenceSchema,
  writerUserId: UserIdSchema,
  writtenAt: IsoDateTimeSchema,
});
export const TeamSqlInputSchema = z.strictObject({
  mode: z.enum(["read", "write"]).default("read"),
  sql: z.string().min(1).max(32768).optional(),
  parameters: z.array(z.json()).max(100).default([]),
  operationId: z.uuid().optional(),
});
export const TeamSqlResultSchema = z
  .strictObject({
    columns: z.array(z.string().max(255)).max(100),
    rows: z.array(z.array(z.json()).max(100)).max(1000),
    sources: z.array(TeamSourceSchema).max(100),
    truncated: z.boolean(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
    "SQL result exceeds byte bound",
  );
