import { DeviceIdSchema } from "@opensteer/core";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { CursorSchema, OperationKeySchema } from "./inputs.js";
import { IntegrationCallOutputSchema } from "./integration-outputs.js";
import { AgentLinkSchema, RequestCreationOutputSchema } from "./outputs.js";

const accessState = z.enum(["enabled", "disabled", "unsupported"]);
const availability = z.object({
  state: z.string(),
  reason: z.object({ kind: z.string() }).nullable(),
});
const PhoneDisplaySchema = z.object({
  definitionId: z.string(),
  control: availability,
  input: availability,
  navigationButtons: z
    .array(z.object({ id: z.string() }))
    .transform((buttons) => buttons.map(({ id }) => id)),
  actions: z.array(z.string()),
  setup: z.object({ location: z.string(), driverRunnerName: z.string().optional() }),
});
export const computer_list = defineAgentTool({
  name: "computer_list",
  title: "List computers",
  description:
    "List the person's computers and phones: kind, online state, which one hosts tasks and can run them now, capabilities, browser, apps and files access switches, and active session IDs. A phone whose screen agents can control has phoneDisplay: its definitionId, control and input availability with a typed reason, advertised navigation buttons and actions, and setup (a Mac-driven iPhone names its driving Mac). Only a computer with hosting runs tasks or shell sessions; a Mac-driven iPhone never lends its Mac. Devices with access off are listed too; listing grants no access.",
  input: z.strictObject({
    cursor: CursorSchema.optional().describe("nextCursor from the previous page."),
  }),
  output: z.object({
    computers: z.array(
      z.object({
        computerId: DeviceIdSchema,
        link: AgentLinkSchema.optional(),
        name: z.string(),
        kind: z.string(),
        online: z.boolean(),
        hosting: z.boolean(),
        canRunTasks: z.boolean(),
        capabilities: z.array(z.string()),
        revoked: z.boolean(),
        access: z.object({ browser: accessState, apps: accessState, files: accessState }),
        sessions: z.array(z.object({ id: z.string() })),
        phoneDisplay: PhoneDisplaySchema.optional(),
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
    computerId: DeviceIdSchema,
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
    "Remove a computer or phone from Opensteer, or end one of its access sessions. Removing a computer revokes it, ending its sessions and deleting its browser profiles; iPhones it drives stay listed as not connected. Removing a Mac-driven iPhone removes only that iPhone and its approvals; its Mac stays. Adding either back needs the person.",
  input: z
    .strictObject({
      target: z.enum(["computer", "session"]),
      computerId: DeviceIdSchema.optional().describe("computer: the computer or phone to remove."),
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
    "Run JavaScript to operate approved Mac windows and phone screens (Android Agent Phones and Mac-driven iPhones); variables and handles last for this Run attempt. tab(tabId), using an ID from tab_list or tab_open, binds that exact window or phone. apps() and phones() list visible targets with either access (read/read-write) or blocked {code,message,next}; app(query) and phone(query) match name, id or computerId and throw that blocked error when access is missing. Bound handles report tabId. Observe before using screenshot coordinates or element indices. Await calls and print() results; execution has a 100 second deadline. Read opensteer:computer-use for the window and phone API. After an outcome-unknown action, observe before repeating it.",
  input: z.strictObject({ code: z.string().min(1).max(65536) }),
  output: IntegrationCallOutputSchema,
  capability: "computerUse",
  access: "write",
  callers: ["run"] as const,
  openWorld: true,
  destructive: true,
});

export const computer_access_request = defineAgentTool({
  name: "computer_access_request",
  opensRequest: true,
  title: "Request computer access",
  description:
    "Ask the person to turn on access to one of their computers: browser, apps or files when a refusal or computer_list shows that switch off, or macOS Full Disk Access when authorized SSH work needs protected files and the other-computers note says it is off. Never ask for an offline computer, and never ask again after Not now in this task. Access granted later resumes in a new Run; app, profile and system permissions still apply.",
  input: z.strictObject({
    computerId: DeviceIdSchema.describe("Computer or phone from the refusal or computer_list."),
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
