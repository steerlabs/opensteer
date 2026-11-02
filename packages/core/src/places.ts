import { z } from "zod";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema, RunnerIdSchema } from "./ids.js";

export const PlaceIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("browser"),
    sessionId: BrowserSessionIdSchema,
    surfaceId: BrowserSurfaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal("app"),
    machineId: RunnerIdSchema,
    appKey: z.string().min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal("phone"),
    machineId: RunnerIdSchema,
    display: z.string().min(1).max(255),
  }),
]);
export type PlaceIdentity = z.infer<typeof PlaceIdentitySchema>;
export const PlaceIdentityViewSchema = z.discriminatedUnion("kind", [
  z.object(PlaceIdentitySchema.options[0].shape),
  z.object(PlaceIdentitySchema.options[1].shape),
  z.object(PlaceIdentitySchema.options[2].shape),
]);
export function placeIdentityKey(place: PlaceIdentity): string {
  if (place.kind === "browser") return `browser:${place.sessionId}:${place.surfaceId}`;
  if (place.kind === "app") return `app:${place.machineId}:${place.appKey}`;
  return `phone:${place.machineId}:${place.display}`;
}
