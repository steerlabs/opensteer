import { DeviceIdSchema } from "./devices.js";
import { z } from "zod";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "./ids.js";

export const PlaceIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("browser"),
    sessionId: BrowserSessionIdSchema,
    surfaceId: BrowserSurfaceIdSchema,
  }),
  z.strictObject({
    kind: z.literal("app"),
    machineId: DeviceIdSchema,
    appKey: z.string().min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal("phone"),
    machineId: DeviceIdSchema,
    display: z.string().min(1).max(255),
  }),
]);
export type PlaceIdentity = z.infer<typeof PlaceIdentitySchema>;
export function placeIdentityKey(place: PlaceIdentity): string {
  if (place.kind === "browser") return `browser:${place.sessionId}:${place.surfaceId}`;
  if (place.kind === "app") return `app:${place.machineId}:${place.appKey}`;
  return `phone:${place.machineId}:${place.display}`;
}
