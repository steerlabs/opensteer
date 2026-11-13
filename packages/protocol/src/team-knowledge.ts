import { z } from "zod";
import {
  IsoDateTimeSchema,
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import { TeamTopicCanSchema } from "./team-access.js";

/** The knowledge bounds, so a request the team Host would refuse is refused at the wire. */
export const teamKnowledgeLimits = {
  topicNameChars: 160,
  descriptionChars: 500,
  titleChars: 200,
  bodyBytes: 65_536,
  previewChars: 200,
  queryChars: 500,
  pageSize: 50,
  searchResults: 20,
  agentTopics: 200,
  /** An agent read stops adding note bodies once its answer reaches this size. */
  agentReadBytes: 200_000,
} as const;
const fitsBytes = (max: number) => (value: string) =>
  new TextEncoder().encode(value).byteLength <= max;

export const TeamTopicNameSchema = z.string().trim().min(1).max(teamKnowledgeLimits.topicNameChars);
export const TeamTopicDescriptionSchema = z
  .string()
  .trim()
  .max(teamKnowledgeLimits.descriptionChars);
export const TeamNoteTitleSchema = z.string().trim().min(1).max(teamKnowledgeLimits.titleChars);
export const TeamNoteBodySchema = z
  .string()
  .refine(fitsBytes(teamKnowledgeLimits.bodyBytes), "A note is at most 64 KB.");
export const TeamNoteVersionSchema = z.number().int().positive();
export const TeamKnowledgeCursorSchema = z.string().min(1).max(256);

/** Who can read a topic: everyone in the team, or this many people. */
export const TeamTopicAudienceSchema = z.strictObject({
  everyone: z.boolean(),
  people: z.number().int().nonnegative(),
});
export type TeamTopicAudience = z.infer<typeof TeamTopicAudienceSchema>;

export const TeamTopicSchema = z.strictObject({
  id: KnowledgeTopicIdSchema,
  name: TeamTopicNameSchema,
  description: TeamTopicDescriptionSchema,
  archivedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  noteCount: z.number().int().nonnegative(),
  audience: TeamTopicAudienceSchema,
  can: TeamTopicCanSchema,
});
export type TeamTopic = z.infer<typeof TeamTopicSchema>;

export const TeamNoteWriterSchema = z.strictObject({
  /** "agent" is the named person's own agent. */
  kind: z.enum(["human", "agent"]),
  userId: UserIdSchema,
  name: z.string().min(1).max(120),
});
export type TeamNoteWriter = z.infer<typeof TeamNoteWriterSchema>;

/** The asking team message an agent's write answered. */
export const TeamNoteSourceSchema = z.strictObject({
  channelId: TeamChannelIdSchema,
  messageId: TeamMessageIdSchema,
});

/** One version of a note; the newest is the note itself. */
export const TeamNoteSchema = z.strictObject({
  id: KnowledgeNoteIdSchema,
  topicId: KnowledgeTopicIdSchema,
  version: TeamNoteVersionSchema,
  title: TeamNoteTitleSchema,
  body: z.string(),
  deleted: z.boolean(),
  writtenAt: IsoDateTimeSchema,
  writer: TeamNoteWriterSchema,
  source: TeamNoteSourceSchema.nullable(),
});
export type TeamNote = z.infer<typeof TeamNoteSchema>;

/** A note in a list: its title and the start of its body. */
export const TeamNotePreviewSchema = TeamNoteSchema.omit({ body: true, deleted: true }).extend({
  preview: z.string().max(teamKnowledgeLimits.previewChars),
});
export type TeamNotePreview = z.infer<typeof TeamNotePreviewSchema>;

/** What an agent sees of a topic. `roomCanRead` is present in a team request's Run. */
export const TeamKnowledgeTopicViewSchema = z.strictObject({
  id: KnowledgeTopicIdSchema,
  name: TeamTopicNameSchema,
  description: TeamTopicDescriptionSchema,
  canWrite: z.boolean(),
  archived: z.boolean(),
  audience: TeamTopicAudienceSchema,
  roomCanRead: z
    .boolean()
    .optional()
    .describe("True when everyone in the asking channel can already read this topic."),
});
export type TeamKnowledgeTopicView = z.infer<typeof TeamKnowledgeTopicViewSchema>;

export const TeamKnowledgeTopicsResultSchema = z.strictObject({
  topics: z.array(TeamKnowledgeTopicViewSchema).max(teamKnowledgeLimits.agentTopics),
});
export type TeamKnowledgeTopicsResult = z.infer<typeof TeamKnowledgeTopicsResultSchema>;

/**
 * An agent's read: search across topics, list a topic, or open one note or its versions.
 * Exactly one of `noteId`, or `query` and/or `topicId`.
 */
export const TeamKnowledgeReadInputSchema = z
  .strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(teamKnowledgeLimits.queryChars)
      .optional()
      .describe("Words to search for in note titles and text."),
    topicId: KnowledgeTopicIdSchema.optional().describe("Limit to one topic."),
    noteId: KnowledgeNoteIdSchema.optional().describe("Open one note."),
    history: z.boolean().optional().describe("With noteId: every version, newest first."),
    before: TeamKnowledgeCursorSchema.optional().describe("nextBefore from the previous page."),
  })
  .refine(
    (input) =>
      input.noteId
        ? input.query === undefined && input.topicId === undefined
        : input.history !== true && (input.query !== undefined || input.topicId !== undefined),
    "Pass noteId alone, or query and/or topicId.",
  );
export type TeamKnowledgeReadInput = z.infer<typeof TeamKnowledgeReadInputSchema>;

export const TeamKnowledgeReadResultSchema = z.strictObject({
  notes: z.array(TeamNoteSchema).max(teamKnowledgeLimits.pageSize),
  /** The topics the notes are in, with who can read them. */
  topics: z.array(TeamKnowledgeTopicViewSchema).max(teamKnowledgeLimits.pageSize),
  nextBefore: TeamKnowledgeCursorSchema.nullable(),
  /** Some bodies were left out to keep the answer small; open those notes one at a time. */
  truncated: z.boolean(),
});
export type TeamKnowledgeReadResult = z.infer<typeof TeamKnowledgeReadResultSchema>;

/**
 * A write as the team Host receives it. `expectedVersion` null creates `noteId` in `topicId`;
 * otherwise it replaces or deletes the note when it is still at that version.
 */
export const TeamKnowledgeWriteSchema = z
  .strictObject({
    noteId: KnowledgeNoteIdSchema,
    topicId: KnowledgeTopicIdSchema.optional(),
    expectedVersion: TeamNoteVersionSchema.nullable(),
    title: TeamNoteTitleSchema.optional(),
    body: TeamNoteBodySchema.optional(),
    delete: z.literal(true).optional(),
  })
  .refine(
    (input) =>
      input.expectedVersion === null
        ? input.topicId !== undefined &&
          input.title !== undefined &&
          input.body !== undefined &&
          input.delete === undefined
        : input.delete
          ? input.title === undefined && input.body === undefined
          : input.title !== undefined || input.body !== undefined,
    "A new note needs topicId, title and body; a change needs title or body; a delete needs neither.",
  );
export type TeamKnowledgeWrite = z.infer<typeof TeamKnowledgeWriteSchema>;

export const TeamKnowledgeWriteResultSchema = z.discriminatedUnion("written", [
  z.strictObject({
    written: z.literal(true),
    noteId: KnowledgeNoteIdSchema,
    topicId: KnowledgeTopicIdSchema,
    version: TeamNoteVersionSchema,
  }),
  z.strictObject({
    written: z.literal(false),
    /** The note as it is now; someone changed it after the version you read. */
    current: TeamNoteSchema,
  }),
]);
export type TeamKnowledgeWriteResult = z.infer<typeof TeamKnowledgeWriteResultSchema>;
