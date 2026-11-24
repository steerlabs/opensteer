import { HarnessInstanceIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { CursorSchema } from "./inputs.js";
import { AiAccountListOutputSchema } from "./outputs.js";

export const AiAccountListInputSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .max(256)
    .transform((query) => query || undefined)
    .optional()
    .describe("Words that must all match a model, provider or account name."),
  aiAccountId: HarnessInstanceIdSchema.optional().describe(
    "Show only this account, to page through its models.",
  ),
  cursor: CursorSchema.optional().describe("nextCursor from the previous page."),
});
export type AiAccountListInput = z.output<typeof AiAccountListInputSchema>;

export const opensteer_ai_account_list = defineAgentTool({
  name: "opensteer_ai_account_list",
  title: "List AI accounts",
  description:
    "List the AI accounts that can run tasks, with their models and options, your access ceiling, budgets and the default for delegated tasks. Copy aiAccountId and model values exactly; an unavailable choice never means a substitute. Pass aiAccountId to page through one account's models.",
  input: AiAccountListInputSchema,
  output: AiAccountListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const aiAccountTools = [opensteer_ai_account_list] as const;
