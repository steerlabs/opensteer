import { z } from "zod";
import {
  IsoDateTimeSchema,
  KnowledgeTopicIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  UserIdSchema,
  SequenceSchema,
} from "@opensteer/core";
import { TeamTopicCanSchema } from "./team-access.js";

/** The knowledge engine's bounds, so a request it would refuse is refused at the wire. */
export const teamKnowledgeLimits = {
  factsPerWrite: 25,
  thingBytes: 256,
  propertyBytes: 128,
  sqlResultBytes: 524_288,
} as const;
const fitsBytes = (max: number) => (value: string) =>
  new TextEncoder().encode(value).byteLength <= max;

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
  thing: z.string().min(1).refine(fitsBytes(teamKnowledgeLimits.thingBytes)),
  property: z.string().min(1).refine(fitsBytes(teamKnowledgeLimits.propertyBytes)),
  value: z.json(),
  /** The version the writer saw; null when they saw none. A newer version refuses the write. */
  replacesId: SequenceSchema.nullable(),
});
export const TeamFactSchema = TeamFactInputSchema.extend({
  id: SequenceSchema,
  writerUserId: UserIdSchema,
  /** "agent" is the writer's own agent. */
  writerKind: z.enum(["human", "agent"]),
  writtenAt: IsoDateTimeSchema,
  /** The asking message an agent's write answered. */
  source: z
    .strictObject({ channelId: TeamChannelIdSchema, messageId: TeamMessageIdSchema })
    .nullable(),
});
export type TeamFact = z.infer<typeof TeamFactSchema>;

/** The agent's `sql` call as the personal Host forwards it, with that call's stable operation key. */
export const TeamSqlInputSchema = z.strictObject({
  query: z.string().min(1).max(16_384).optional(),
  parameters: z.array(z.json()).max(64).optional(),
  mode: z.enum(["read", "write"]).default("read"),
  onlyIfUnchanged: z.boolean().optional(),
  cursor: KnowledgeTopicIdSchema.optional(),
  operationKey: z.string().regex(/^[\x21-\x7e]{1,128}$/),
});
export type TeamSqlInput = z.infer<typeof TeamSqlInputSchema>;
const SqlColumnSchema = z.strictObject({
  name: z.string().max(255),
  postgresType: z.string().max(255),
});
export const TeamSqlResultSchema = z
  .strictObject({
    relations: z
      .array(
        z.strictObject({
          name: z.string().max(64),
          columns: z.array(SqlColumnSchema).max(64),
          insertable: z.array(z.string().max(64)).max(16),
        }),
      )
      .max(8)
      .optional(),
    topics: z
      .array(z.strictObject({ id: KnowledgeTopicIdSchema, name: z.string().max(160) }))
      .max(50)
      .optional(),
    nextCursor: KnowledgeTopicIdSchema.optional(),
    columns: z.array(SqlColumnSchema).max(1664).optional(),
    rows: z.array(z.array(z.json()).max(1664)).max(200).optional(),
    truncated: z.boolean().optional(),
    receipt: z
      .strictObject({
        committed: z.literal(true),
        replayed: z.boolean(),
        facts: z
          .array(
            z.strictObject({
              id: SequenceSchema,
              topic: KnowledgeTopicIdSchema,
              thing: z.string(),
              property: z.string(),
              replacesId: SequenceSchema.nullable(),
              seenFactId: SequenceSchema.nullable(),
              baseline: z.enum(["observed", "unknown"]),
              unseenCount: z.number().int().nonnegative().nullable(),
              unseen: z
                .array(
                  z.strictObject({
                    id: SequenceSchema,
                    writerKind: z.enum(["human", "agent"]),
                    writerId: UserIdSchema,
                    writtenAt: z.string(),
                  }),
                )
                .max(20)
                .nullable(),
            }),
          )
          .max(teamKnowledgeLimits.factsPerWrite),
      })
      .optional(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      teamKnowledgeLimits.sqlResultBytes,
    "SQL result exceeds byte bound",
  );
export type TeamSqlResult = z.infer<typeof TeamSqlResultSchema>;
