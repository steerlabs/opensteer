import {
  DelegationModelChoiceSchema,
  HarnessInstanceIdSchema,
  ThreadAccessModeSchema,
  TimeZoneSchema,
} from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { CursorSchema } from "./inputs.js";
import {
  AiAccountListOutputSchema,
  DefaultsOutputSchema,
  DefaultsUpdateOutputSchema,
} from "./outputs.js";

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

const ModelLimitsSchema = z.strictObject({
  contextWindow: z.number().int().positive().max(10_000_000),
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
});
const aiAccountActions = {
  rename: "name",
  enable: undefined,
  disable: undefined,
  set_default: undefined,
  set_model_limits: "modelLimits",
} as const;
export const opensteer_ai_account_update = defineAgentTool({
  name: "opensteer_ai_account_update",
  title: "Change an AI account",
  description:
    "Rename, enable or disable an AI account, make it the default for its engine, or set a model's context and output limits. Signing in, adding accounts and credentials need the person.",
  input: z
    .strictObject({
      aiAccountId: HarnessInstanceIdSchema,
      action: z.enum(["rename", "enable", "disable", "set_default", "set_model_limits"]),
      name: z.string().trim().min(1).max(120).optional().describe("rename: the new name."),
      modelLimits: z
        .strictObject({
          modelId: z.string().min(1).max(255).describe("Model ID from opensteer_ai_account_list."),
          limits: ModelLimitsSchema.nullable().describe("New limits, or null to clear them."),
        })
        .optional()
        .describe("set_model_limits: the model and its limits."),
    })
    .superRefine((input, context) => {
      for (const [action, field] of Object.entries(aiAccountActions)) {
        if (!field) continue;
        if ((input.action === action) !== (input[field] !== undefined))
          context.addIssue({
            code: "custom",
            message: `${field} is required for ${action} and only for it`,
            path: [field],
          });
      }
    }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const opensteer_defaults_read = defineAgentTool({
  name: "opensteer_defaults_read",
  title: "Read new-task defaults",
  description:
    "Read what a new task starts with: its AI account, model and access mode, and the person's time zone.",
  input: z.strictObject({}),
  output: DefaultsOutputSchema,
  access: "read",
  callers: ["run", "connection"] as const,
});

export const opensteer_defaults_update = defineAgentTool({
  name: "opensteer_defaults_update",
  title: "Change new-task defaults",
  description:
    "Change what a new task starts with, or the person's time zone, and return what changed. The access mode cannot exceed your own ceiling, and nothing here changes an existing task.",
  input: z
    .strictObject({
      selection: z
        .strictObject({
          aiAccountId: HarnessInstanceIdSchema,
          model: DelegationModelChoiceSchema,
        })
        .optional()
        .describe("AI account and model from opensteer_ai_account_list."),
      accessMode: ThreadAccessModeSchema.optional(),
      timeZone: TimeZoneSchema.optional().describe("IANA zone, such as America/New_York."),
    })
    .refine(
      (input) =>
        input.selection !== undefined ||
        input.accessMode !== undefined ||
        input.timeZone !== undefined,
      "Name a selection, an access mode or a time zone",
    ),
  output: DefaultsUpdateOutputSchema,
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const aiAccountTools = [
  opensteer_ai_account_list,
  opensteer_ai_account_update,
  opensteer_defaults_read,
  opensteer_defaults_update,
] as const;
