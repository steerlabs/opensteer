import { z } from "zod";
import { AgentLinkSchema } from "./agent-links.js";

const AppSchema = z.object({
  name: z.string().optional(),
  bundleId: z.string().optional(),
  packageName: z.string().optional(),
  label: z.string().optional(),
  identity: z
    .object({
      displayName: z.string(),
      bundleId: z.string().optional(),
      packageName: z.string().optional(),
    })
    .optional(),
  access: z.string().optional(),
  status: z.string().optional(),
  blocked: z.boolean().optional(),
  callable: z.boolean().optional(),
  pending: z.string().optional(),
  inUse: z.boolean().optional(),
  heldByTask: z.string().optional(),
});
const ComputerSchema = z.object({
  computerId: z.string(),
  name: z.string(),
  state: z.string(),
  appApproval: z.string().optional(),
  computerToolEnabled: z.boolean(),
  computerUseVersion: z.number().nullable().optional(),
  apps: z.array(AppSchema).optional(),
});
const PhoneSchema = z.object({
  computerId: z.string(),
  name: z.string(),
  state: z.string(),
  approval: z.string(),
  access: z.string().optional(),
  inUse: z.boolean().optional(),
  callable: z.boolean(),
  computerToolEnabled: z.boolean(),
  heldByTask: z.string().optional(),
});
export const ComputerAppsOutputSchema = z.object({
  guidance: z
    .object({
      computers: z.string().optional(),
      phones: z.string().optional(),
    })
    .optional(),
  computers: z.array(ComputerSchema).optional(),
  phones: z.array(PhoneSchema).optional(),
  computer: ComputerSchema.optional(),
  apps: z.array(AppSchema).optional(),
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
  link: AgentLinkSchema.optional(),
  status: z.string(),
  kind: z.string().optional(),
  replayed: z.boolean().optional(),
  requestId: z.string().nullable().optional(),
  alreadyGranted: z.boolean().optional(),
  nextAction: z.string().optional(),
  guidance: z.string().optional(),
});
