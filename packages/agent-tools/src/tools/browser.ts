import { defineAgentTool } from "../registry.js";
import {
  BrowserProfileIdSchema,
  BrowserTabReadInputSchema,
  BrowserTabWriteInputSchema,
  EnvironmentIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";

import { z } from "zod";

import {
  OperationKeySchema,
  BrowserSessionIdInputSchema,
  BrowserAccessSuggestionInputSchema,
} from "./inputs.js";
import {
  BrowserProfileListOutputSchema,
  SignInOutputSchema,
  RequestCreationOutputSchema,
  BrowserTabReadOutputSchema,
  BrowserTabWriteOutputSchema,
  BrowserSessionListOutputSchema,
  BrowserSessionOpenOutputSchema,
  BrowserProfileCreateOutputSchema,
  BrowserSessionCloseOutputSchema,
} from "./outputs.js";
export const browser_profile_list = defineAgentTool({
  name: "browser_profile_list",
  title: "List Browser Profiles",
  description:
    "List profiles: Main inherits owner profiles; Projects see grants. Named profiles keep browser data on their owning computer. The list provides identity and grants; verify website sign-ins on the website.",
  input: z.strictObject({}),
  output: BrowserProfileListOutputSchema,
  access: "read",
  callers: ["run"] as const,
});

export const sign_in = defineAgentTool({
  name: "sign_in",
  title: "Sign In",
  description:
    "Authorize a saved login or reuse Chrome sign-in. For a website, open its sign-in page and pass sessionId and site; for its genuine Mac or phone app, omit sessionId. On ready, use loginRef with Browser Harness fillLogin or device typing by field reference (username, password or code); never read or reveal saved fields. On pending, do independent work then end your turn for approval. Delegated Runs use allowed sites; needs-approval goes to the assigner. Verify the intended account after signing in.",
  input: z
    .strictObject({
      reason: z.string().trim().min(1).max(500),
      sessionId: BrowserSessionIdInputSchema.optional(),
      site: z.string().trim().min(1).max(2_048),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: SignInOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_access_request = defineAgentTool({
  name: "browser_access_request",
  title: "Request Browser Access",
  description:
    "Request a browser profile grant for the target Project's workspaceId. Project grants provide profiles to that Project; specialist bindings separately limit which profiles a specialist may use. Main already has owner profiles; use browser_profile_list or browser_profile_create there. Guest needs no grant. The owner decides which profile to grant; suggestion is advisory. Returns the Request and whether this call was replayed. Never target Main.",
  input: z
    .strictObject({
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Why the Project needs browser profile access."),
      suggestion: BrowserAccessSuggestionInputSchema,
      workspaceId: WorkspaceIdSchema.optional().describe(
        "Project receiving the grant; never Main.",
      ),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestCreationOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_tab_read = defineAgentTool({
  name: "browser_tab_read",
  title: "Read saved tabs",
  description:
    "Find saved tabs, open or asleep, and their groups. tabId is Browser Harness surfaceId. Every page includes reachable groups and tabCount. profileId is null for Guest. Groups grant no access.",
  input: BrowserTabReadInputSchema,
  output: BrowserTabReadOutputSchema,
  access: "read",
  callers: ["run"] as const,
});

export const browser_tab_write = defineAgentTool({
  name: "browser_tab_write",
  title: "Organize saved tabs",
  description:
    "Organize saved tabs and groups. tabId equals Browser Harness surfaceId. Use group, ungroup, move, update_group, close or restore. For move, omit toGroupId for root and before for the end. For restore, pass up to eight tabIds; returned sessionIds are attached to this Run. Groups change organization, not access.",
  input: BrowserTabWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserTabWriteOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_session_list = defineAgentTool({
  name: "browser_session_list",
  title: "List Browser Sessions",
  description:
    "To find persistent sessions, use browser_session_list. attached marks sessions open in this Run. Main also sees the owner's sessions from Projects.",
  input: z.strictObject({}),
  output: BrowserSessionListOutputSchema,
  access: "read",
  callers: ["run"] as const,
});

export const browser_session_open = defineAgentTool({
  name: "browser_session_open",
  title: "Open Browser Session",
  description:
    "Attach with sessionId, or start a session with profileId or fresh: true for Guest. Choose exactly one. Guest needs no grant and loses its data on close. Sessions outlive Runs; a Run can use several. Use Browser Harness to drive them. Session identity and a placed profile's computer cannot change. If an update is required, report it; do not bypass it with another profile, computer or Guest.",
  input: z
    .strictObject({
      environmentId: EnvironmentIdSchema.optional().describe(
        "A placed profile uses its fixed computer. Otherwise defaults to this Run's machine, else the only connected browser; never chooses identity.",
      ),
      fresh: z.literal(true).optional(),
      profileId: BrowserProfileIdSchema.optional(),
      sessionId: BrowserSessionIdInputSchema.optional(),
    })
    .refine(
      (input) => [input.fresh, input.profileId, input.sessionId].filter(Boolean).length === 1,
      "Choose exactly one of an existing session to attach, a granted browser profile, or a fresh session",
    )
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserSessionOpenOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_profile_create = defineAgentTool({
  name: "browser_profile_create",
  title: "Create Browser Profile",
  description:
    "For a requested new or missing profile, list first, then create with name. Names may repeat and never prove login. Creation opens nothing; placement may wait until first open. Open profile.id with browser_session_open, then sign in. Report update refusals; never create replacements.",
  input: z
    .strictObject({
      name: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("One or two words, such as Work or Shopping."),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserProfileCreateOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_session_close = defineAgentTool({
  name: "browser_session_close",
  title: "Close Browser Session",
  description:
    "To close a persistent session for every attached Run and viewer, pass its exact sessionId.",
  input: z
    .strictObject({ sessionId: BrowserSessionIdInputSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserSessionCloseOutputSchema,
  access: "self",
  callers: ["run"] as const,
  destructive: true,
});
