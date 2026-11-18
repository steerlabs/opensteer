import { BlockedSchema, RequestStatusSchema } from "@opensteer/core";
import { z } from "zod";
import { AgentLinkSchema } from "./agent-links.js";

const AccessSchema = z.union([
  z.object({ access: z.enum(["read", "read-write"]), blocked: z.never().optional() }),
  z.object({ blocked: BlockedSchema, access: z.never().optional() }),
]);
const AppSchema = z.object({ name: z.string(), bundleId: z.string() }).and(AccessSchema);
const ComputerSchema = z.object({
  computerId: z.string(),
  name: z.string(),
  blocked: BlockedSchema.optional(),
  apps: z.array(AppSchema),
});
const PhoneSchema = z
  .object({
    computerId: z.string(),
    name: z.string(),
    definitionId: z.enum(["android-phone", "iphone-screen"]),
  })
  .and(AccessSchema);
export const ComputerAppsOutputSchema = z.object({
  guidance: z
    .object({ computers: z.string().optional(), phones: z.string().optional() })
    .optional(),
  computers: z.array(ComputerSchema).optional(),
  phones: z.array(PhoneSchema).optional(),
  computer: ComputerSchema.optional(),
  apps: z
    .array(
      z.object({
        label: z.string(),
        appId: z.string(),
        packageName: z.string().optional(),
        access: z.never().optional(),
        blocked: z.never().optional(),
      }),
    )
    .optional(),
  total: z.number().optional(),
  nextCursor: z.string().nullable().optional(),
});
export const AgentImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
  _meta: z
    .object({ "codex/imageDetail": z.enum(["auto", "low", "high", "original"]).optional() })
    .optional(),
});
export const AgentMediaContentSchema = z.union([
  AgentImageContentSchema,
  z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }),
]);
/** What `computer_use` returns: its printed text and observation images, as MCP content. */
export const ComputerUseOutputSchema = z.object({
  content: z.array(
    z.union([z.object({ type: z.literal("text"), text: z.string() }), AgentMediaContentSchema]),
  ),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export const AppAccessRequestOutputSchema = z.object({
  computerId: z.string().optional(),
  computer: z.string().optional(),
  app: z.object({ displayName: z.string(), bundleId: z.string() }).nullable().optional(),
  link: AgentLinkSchema.optional(),
  status: RequestStatusSchema.or(z.literal("blocked")),
  kind: z.string(),
  replayed: z.boolean().optional(),
  requestId: z.string().nullable(),
  next: z.string().min(1),
});
