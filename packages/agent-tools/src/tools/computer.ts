import { RunnerIdSchema, requestReasonMaxLength } from "@opensteer/core";
import { IntegrationAccessSchema } from "@opensteer/integration-core/access";
import { z } from "zod";
import { defineAgentTool } from "../registry.js";
import { CursorSchema, OperationKeySchema } from "./inputs.js";
import {
  AppAccessRequestOutputSchema,
  ComputerAppsOutputSchema,
  ComputerUseOutputSchema,
} from "./computer-outputs.js";
import { AgentLinkSchema, RequestCreationOutputSchema } from "./outputs.js";

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
        link: AgentLinkSchema.optional(),
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
    "Run JavaScript to operate approved Mac windows and Agent Phones; variables and handles last for this Run attempt. tab(tabId), using an ID from tab_list or tab_open, binds that exact window or phone. apps()/app() and phones()/phone() also discover and bind targets. Bound handles report tabId. Observe before using screenshot coordinates or element indices. Await calls and print() results; execution has a 100 second deadline. Read opensteer:computer-use for the window and phone API. After an outcome-unknown action, observe before repeating it.",
  input: z.strictObject({ code: z.string().min(1).max(65536) }),
  output: ComputerUseOutputSchema,
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
    computerId: RunnerIdSchema.describe("Computer from the refusal or computer_list."),
    access: z.enum(["browser", "apps", "files", "full_disk_access"]),
    reason: z.string().trim().min(1).max(500).describe("Why this task needs that access."),
    operationKey: OperationKeySchema.optional(),
  }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const ComputerAppsInputSchema = z.strictObject({
  computerId: RunnerIdSchema.optional().describe(
    "computerId from this listing or computer_list; omit to list Macs and Agent Phones.",
  ),
  query: z.string().trim().max(240).default("").describe("Filters a computer's installed apps."),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .regex(/^\d{1,5}$/u)
    .transform(Number)
    .pipe(z.number().int().max(10_000))
    .optional()
    .describe("nextCursor from the previous page."),
});
export const computer_apps = defineAgentTool({
  name: "computer_apps",
  title: "List Mac apps and phones",
  description:
    "List the Macs set up for computer use, each with its approval policy and its approved or waiting apps, and the Agent Phones with their approval. Pass a computerId to list that Mac's or phone's installed apps, filtered by query; phone apps include launch package names. Listing grants no access; ask with app_access_request.",
  input: ComputerAppsInputSchema,
  output: ComputerAppsOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

/**
 * One app on one Mac, a whole phone, one device data app, or one local server. The Host resolves
 * what `app`, `dataApp` and `server` name.
 */
export const AppAccessRequestInputSchema = z
  .strictObject({
    computerId: RunnerIdSchema.optional().describe(
      "computerId from computer_apps or computer_list. Omit for a Mac app on this task’s computer; for dataApp, the person chooses its computer if it has no connection yet. Omit for server.",
    ),
    app: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("Mac app name, path or bundle ID, operated through computer_use."),
    dataApp: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "A data app whose tools appear in plugin_search: calendar, contacts, reminders or messages on a Mac; calendar, contacts, reminders, photos or location on an iPhone.",
      ),
    server: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("A local server's name from local_server_list."),
    access: IntegrationAccessSchema,
    reason: z.string().trim().min(1).max(requestReasonMaxLength),
    operationKey: OperationKeySchema.optional(),
  })
  .superRefine((input, context) => {
    const named = [input.app, input.dataApp, input.server].filter((value) => value !== undefined);
    if (named.length > 1)
      context.addIssue({
        code: "custom",
        message: "Name one of app, dataApp or server",
        path: ["app"],
      });
    if (named.length === 0 && input.computerId === undefined)
      context.addIssue({
        code: "custom",
        message: "Name the app on a Mac, a dataApp, a server, or the phone by its computerId",
        path: ["app"],
      });
  });
export const app_access_request = defineAgentTool({
  name: "app_access_request",
  opensRequest: true,
  title: "Request an app, phone or local server",
  description:
    "Ask the person to let this task use one Mac app or a whole Agent Phone through computer_use, a device data app on a Mac or iPhone, or a local server, through their plugin tools. For a Mac app pass app and, unless it is on the Mac this task runs on, its computerId; for a phone pass only its computerId; for a data app pass dataApp and the computerId it is on, when known; for a local server pass server. read observes and read-write also acts. Pending grants no access; never repeat a pending or declined ask.",
  input: AppAccessRequestInputSchema,
  output: AppAccessRequestOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const computerTools = [
  computer_list,
  computer_update,
  computer_remove,
  computer_use,
  computer_apps,
  computer_access_request,
  app_access_request,
] as const;
