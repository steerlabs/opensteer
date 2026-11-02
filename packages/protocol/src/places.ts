import { z } from "zod";
import { RunIdSchema, ThreadIdSchema, IsoDateTimeSchema } from "@opensteer/core";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export {
  PlaceIdentitySchema,
  PlaceIdentityViewSchema,
  placeIdentityKey,
  type PlaceIdentity,
} from "@opensteer/core";
import { PlaceIdentitySchema, PlaceIdentityViewSchema } from "@opensteer/core";
export const PlaceOccupantSchema = z.object({
  threadId: ThreadIdSchema,
  home: z.boolean(),
  holding: z.boolean(),
  acting: z.boolean(),
  lastActiveAt: IsoDateTimeSchema.max(64),
});
export type PlaceOccupant = z.infer<typeof PlaceOccupantSchema>;
export const PlaceActivitySchema = z
  .strictObject({
    place: PlaceIdentitySchema,
    threadId: ThreadIdSchema,
    home: z.boolean(),
    runId: RunIdSchema,
    generation: revision,
    seq: revision,
    order: revision,
    at: revision,
    expiresAt: revision,
    pointer: z
      .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .nullable(),
    geometryRevision: revision,
  })
  .refine(
    (activity) => activity.expiresAt > activity.at && activity.expiresAt - activity.at <= 15_000,
    "Activity must expire within the acting window.",
  );
export type PlaceActivity = z.infer<typeof PlaceActivitySchema>;
export const PlaceActivityViewSchema = z
  .object({
    ...PlaceActivitySchema.shape,
    place: PlaceIdentityViewSchema,
    pointer: z.object(PlaceActivitySchema.shape.pointer.unwrap().shape).nullable(),
  })
  .superRefine((activity, context) => {
    const parsed = PlaceActivitySchema.safeParse(activity);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  });
export const PlaceActivityNoticeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.place-activity"), activity: PlaceActivitySchema }),
  z.object({
    type: z.literal("host.place-activity-cleared"),
    place: PlaceIdentitySchema,
    runId: RunIdSchema,
    generation: revision,
    seq: revision,
  }),
]);
export type PlaceActivityNotice = z.infer<typeof PlaceActivityNoticeSchema>;
export const PlaceActivityNoticeViewSchema = z.discriminatedUnion("type", [
  z.object({ ...PlaceActivityNoticeSchema.options[0].shape, activity: PlaceActivityViewSchema }),
  z.object({ ...PlaceActivityNoticeSchema.options[1].shape, place: PlaceIdentityViewSchema }),
]);

export const ThreadPlaceReferenceSchema = z.object({
  threadId: ThreadIdSchema,
  /**
   * The Run that acted there. A reference without one, from an older Host,
   * names no Run, so no reply shows it as its live picture.
   */
  runId: RunIdSchema.optional(),
  place: PlaceIdentityViewSchema,
  title: z.string().max(256),
  site: z.string().max(2048).nullable(),
  iconRef: z.string().max(128).nullable(),
  order: revision,
  at: IsoDateTimeSchema,
});
export type ThreadPlaceReference = z.infer<typeof ThreadPlaceReferenceSchema>;
export const ThreadPlaceChangedSchema = z.object({
  type: z.literal("host.thread-place-changed"),
  reference: ThreadPlaceReferenceSchema,
});
