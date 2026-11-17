import { TabIdSchema, PersonShowTargetSchema } from "@opensteer/core";
import { z } from "zod";
import { RunIdSchema, ThreadIdSchema, IsoDateTimeSchema } from "@opensteer/core";

export { PlaceIdentitySchema, placeIdentityKey, type PlaceIdentity } from "@opensteer/core";
export const PlaceOccupantSchema = z.object({
  threadId: ThreadIdSchema,
  holding: z.boolean(),
  acting: z.boolean(),
  lastActiveAt: IsoDateTimeSchema.max(64),
});
export type PlaceOccupant = z.infer<typeof PlaceOccupantSchema>;

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ThreadPlaceChangedSchema = z.object({
  type: z.literal("host.thread-place-changed"),
  reference: z.lazy(() => ThreadPlaceReferenceSchema),
});

export const PersonShowMessageSchema = z.object({
  type: z.literal("host.show"),
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
  target: z.union([
    z.object(PersonShowTargetSchema.options[0].shape),
    z.object(PersonShowTargetSchema.options[1].shape),
  ]),
});
export type PersonShowMessage = z.infer<typeof PersonShowMessageSchema>;
export const ThreadPlaceReferenceSchema = z.object({
  taskId: ThreadIdSchema,
  runId: RunIdSchema,
  tabId: TabIdSchema,
  title: z.string().max(1024),
  site: z.string().max(2048).nullable(),
  iconRef: z.string().max(128).nullable(),
  order: revision,
  at: IsoDateTimeSchema,
});
export type ThreadPlaceReference = z.infer<typeof ThreadPlaceReferenceSchema>;
export const TabPlaceActivitySchema = z
  .strictObject({
    tabId: TabIdSchema,
    threadId: ThreadIdSchema,
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
export type TabPlaceActivity = z.infer<typeof TabPlaceActivitySchema>;
export const TabPlaceActivityViewSchema = z
  .object({
    ...TabPlaceActivitySchema.shape,
    pointer: z.object(TabPlaceActivitySchema.shape.pointer.unwrap().shape).nullable(),
  })
  .superRefine((activity, context) => {
    const parsed = TabPlaceActivitySchema.safeParse(activity);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  });
export const TabPlaceActivityNoticeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.place-activity"), activity: TabPlaceActivityViewSchema }),
  z.object({
    type: z.literal("host.place-activity-cleared"),
    tabId: TabIdSchema,
    runId: RunIdSchema,
    generation: revision,
    seq: revision,
  }),
]);
