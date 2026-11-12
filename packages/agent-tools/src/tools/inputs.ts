import { BrowserProfileIdSchema } from "@opensteer/core";

import { z } from "zod";

export const CursorSchema = z.string().trim().min(1).max(2_048);

export const BrowserSessionIdInputSchema = z.string().regex(/^bsn_[0-9a-f-]{36}$/i);
export const BrowserAccessSuggestionInputSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("existing"),
      profileId: BrowserProfileIdSchema.describe(
        "Existing owner profile to suggest; the person decides.",
      ),
    }),
    z.strictObject({
      kind: z.literal("new"),
      suggestedName: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe("One or two plain words, such as Personal, Work or Finance."),
    }),
    z.strictObject({ kind: z.literal("user_choice") }),
  ])
  .describe(
    "Suggestion only: existing profile, new empty profile, or user_choice. The person decides.",
  );
export const OperationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe("Retry key for identical input; usually omit.");
