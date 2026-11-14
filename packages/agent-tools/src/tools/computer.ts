import { RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { CursorSchema, OperationKeySchema } from "./inputs.js";
import { IntegrationCallOutputSchema } from "./integration-outputs.js";
import { RequestCreationOutputSchema } from "./outputs.js";

const accessState = z.enum(["enabled", "disabled", "unsupported"]);
export const computer_list = defineAgentTool({
  name: "computer_list",
  title: "List computers",
  description:
    "List the person's computers and phones: online state, which one hosts tasks and can run them now, capabilities, browser, apps and files access switches, and active session IDs. Computers with access off are listed too; listing grants no access.",
  input: z.strictObject({
    cursor: CursorSchema.optional().describe("nextCursor from the previous page."),
  }),
  output: z.object({
    computers: z.array(
      z.object({
        computerId: RunnerIdSchema,
        name: z.string(),
        online: z.boolean(),
        hosting: z.boolean(),
        canRunTasks: z.boolean(),
        capabilities: z.array(z.string()),
        revoked: z.boolean(),
        access: z.object({ browser: accessState, apps: accessState, files: accessState }),
        sessions: z.array(z.object({ id: z.string() })),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const computer_update = defineAgentTool({
  name: "computer_update",
  title: "Rename a computer",
  description:
    "Rename one of the person's computers. Enrollment, pairing and access switches need the person.",
  input: z.strictObject({
    computerId: RunnerIdSchema,
    name: z.string().trim().min(1).max(120),
  }),
  output: z.object({ ok: z.literal(true) }),
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const computer_remove = defineAgentTool({
  name: "computer_remove",
  title: "Remove a computer or session",
  description:
    "Remove a computer from Opensteer, or end one of its access sessions. Removing a computer revokes it, ending its sessions and deleting its browser profiles; adding it back needs the person.",
  input: z
    .strictObject({
      target: z.enum(["computer", "session"]),
      computerId: RunnerIdSchema.optional().describe("computer: the computer to remove."),
      sessionId: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("session: a session ID from computer_list."),
    })
    .superRefine((input, context) => {
      if ((input.target === "computer") !== (input.computerId !== undefined))
        context.addIssue({ code: "custom", message: "computerId is for target computer" });
      if ((input.target === "session") !== (input.sessionId !== undefined))
        context.addIssue({ code: "custom", message: "sessionId is for target session" });
    }),
  output: z.object({ ok: z.literal(true), ended: z.boolean().optional() }),
  access: "settings",
  callers: ["run", "connection"] as const,
  destructive: true,
});

export const computer_use = defineAgentTool({
  name: "computer_use",
  title: "Operate Mac apps and phones",
  description:
    "Run JavaScript that operates Mac apps and Agent Phones; state persists within this Run only. Discover with apps() and phones(), open app(name, {computer}) or phone(name), then observe. Read opensteer:computer-use for methods and sealed sign-in fields. Await calls and return or print() JSON; the deadline is 100 seconds. Never change permissions or bypass a sign-in. Credentials stay unread, except the authorized phone screen-lock PIN described in opensteer:computer-use.",
  input: z.strictObject({ code: z.string().min(1).max(65536) }),
  output: IntegrationCallOutputSchema,
  access: "write",
  callers: ["run"] as const,
  openWorld: true,
  destructive: true,
});

export const computer_access_request = defineAgentTool({
  name: "computer_access_request",
  title: "Request computer access",
  description:
    "Ask the person to turn on access to one of their computers: browser, apps or files when a refusal or computer_list shows that switch off, or macOS Full Disk Access when authorized SSH work needs protected files. Never ask for an offline computer, and never ask again after Not now in this task. Access granted later resumes in a new Run; app, profile and system permissions still apply.",
  input: z.strictObject({
    computerId: RunnerIdSchema.describe("Computer from the refusal or computer_list."),
    access: z.enum(["browser", "apps", "files", "full_disk_access"]),
    reason: z.string().trim().min(1).max(500).describe("Why this task needs that access."),
    operationKey: OperationKeySchema.optional(),
  }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const computerTools = [
  computer_list,
  computer_update,
  computer_remove,
  computer_use,
  computer_access_request,
] as const;
