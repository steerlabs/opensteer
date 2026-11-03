import type { AgentToolAnnotations } from "../registry.js";
import { BrowserProfileIdSchema, MarkColorSchema, WorkspaceIconNameSchema } from "@opensteer/core";

import { z } from "zod";

export const CursorSchema = z.string().trim().min(1).max(2_048);

export const workspaceNameSchema = z.string().trim().min(1).max(160);
export const WorkspaceCreateInputSchema = z.strictObject({
  icon: WorkspaceIconNameSchema.optional().describe(
    "Icon people see beside this Workspace. Pick the one that best matches its purpose.",
  ),
  color: MarkColorSchema.optional().describe(
    "Colour of this Workspace's mark. Omit to take the one least like this person's other Projects.",
  ),
  name: workspaceNameSchema,
});
export const BrowserSessionIdInputSchema = z.string().regex(/^bsn_[0-9a-f-]{36}$/i);
export const BrowserAccessSuggestionInputSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("existing"),
      profileId: BrowserProfileIdSchema.describe("Owner profile to suggest granting."),
    }),
    z.strictObject({
      kind: z.literal("new"),
      suggestedName: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe("Suggest one or two words, such as Work or Shopping."),
    }),
    z.strictObject({ kind: z.literal("user_choice") }),
  ])
  .describe(
    "Advisory only. user_choice lets the owner choose a grant; it never selects Main's session identity.",
  );
export const browserAccessRequestAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
  title: "Request Browser Access",
} as const satisfies AgentToolAnnotations;

export const OperationKeySchema = z.string().trim().min(1).max(128);
