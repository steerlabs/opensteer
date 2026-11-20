import { DeviceIdSchema, requestReasonMaxLength } from "@opensteer/core";
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
import { directInput } from "./tabs.js";

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
    "List the computers and phones you can see, including whether each is online, what it can do and which access switches are on. A phone with screen control has phoneDisplay, with availability, navigation buttons, actions and setup. An iPhone names its connected Mac only if you can see that Mac. Only computers that host work can run tasks or open shells. Listing a computer does not grant access.",
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
    "Run JavaScript to operate approved Mac windows and phone screens (Android Agent Phones and Mac-driven iPhones); variables and handles last for this Run attempt. tab(tabId), using an ID from tab_list or tab_open, binds that exact window or phone. apps() and phones() list visible targets with either access (read/read-write) or blocked {code,message,next}; app(query) and phone(query) match name, id or computerId and throw that blocked error when access is missing. Bound handles report tabId. Observe before using screenshot coordinates or element indices. Await calls and print() results; execution has a 100 second deadline. Read opensteer:computer-use for the window and phone API. After an outcome-unknown action, observe before repeating it. Connected agents: name one app or phone screen shared with you by computerId and app (omit app for a phone screen); the script reaches only that one, and tab() is not available. Use at most 20,000 characters. Set readOnly: true to observe without approval.",
  input: z.strictObject({
    code: z.string().min(1).max(65536),
    computerId: DeviceIdSchema.optional().describe(
      "Connected agents only: the Mac or phone from computer_apps.",
    ),
    app: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .optional()
      .describe("Connected agents only: the Mac app's name or bundleId; omit for a phone screen."),
    readOnly: z
      .boolean()
      .optional()
      .describe("Connected agents only: allow observation, with no input or other changes."),
    ...directInput,
  }),
  output: ComputerUseOutputSchema,
  capability: "computerUse",
  access: "write",
  callers: ["run", "connection"] as const,
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

export const ComputerAppsInputSchema = z.strictObject({
  computerId: DeviceIdSchema.optional().describe(
    "computerId from this listing or computer_list; omit to list Macs and phone screens.",
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
    "List Macs set up for computer use and phone screens (Android Agent Phones and Mac-driven iPhones). Each visible app or phone has access (read/read-write) or blocked {code,message,next}; follow its next step. A computer can also carry its own blocker. Pass a computerId to list that Mac's or phone's installed apps, filtered by query; phone apps include the opaque appId that launch takes. Listing grants no access; ask with app_access_request.",
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
    computerId: DeviceIdSchema.optional().describe(
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
    "Ask the person for access. For a device data app on a Mac or iPhone pass dataApp and its computerId, when known. For a local server pass server. A Trigger occurrence can ask for either and returns pending without a continuation. Only a running task can ask for computer_use access: pass app for one Mac app and its computerId unless the task runs there, or only computerId for a whole phone screen. A Mac-driven iPhone screen needs its own approval. read observes and read-write also acts. Pending grants no access. Never repeat a pending or declined ask.",
  input: AppAccessRequestInputSchema,
  output: AppAccessRequestOutputSchema,
  access: "write",
  callers: ["run", "program"] as const,
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
