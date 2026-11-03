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
  title: "List browser profiles",
  description:
    "Find usable browser identities and grants. Main inheritance exposes owner profiles; Projects need grants, narrowed by specialist bindings. Named data stays on its computer. Names/data never prove a website login; verify there.",
  input: z.strictObject({}),
  output: BrowserProfileListOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const sign_in = defineAgentTool({
  name: "sign_in",
  title: "Request sign-in",
  description:
    "Request saved-login or Chrome sign-in authorization from the person. Run-only. Returns ready/applied/pending/refusal; on pending, do other work then end your turn for continuation. Use ready loginRef only for sealed field filling; never read/reveal credentials. Verify the account. Open a website sign-in page first; omit sessionId for a genuine Mac/phone app.",
  input: z
    .strictObject({
      reason: z.string().trim().min(1).max(500).describe("Why this task needs the account."),
      sessionId: BrowserSessionIdInputSchema.optional().describe(
        "Website session on its sign-in page; omit for a genuine app.",
      ),
      site: z
        .string()
        .trim()
        .min(1)
        .max(2_048)
        .describe("Site whose login is needed, such as github.com."),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: SignInOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_access_request = defineAgentTool({
  name: "browser_access_request",
  title: "Request browser access",
  description:
    "Ask the person to grant a browser profile to a reachable Project. Run-only. Main already inherits owner profiles; never target it. Omit workspaceId for this Project. Only the person chooses the grant. Returns requestId/status/replayed; pending grants no access. End your turn for continuation. Guest needs no grant.",
  input: z
    .strictObject({
      reason: z.string().trim().min(1).max(500).describe("Why this Project needs the profile."),
      suggestion: BrowserAccessSuggestionInputSchema,
      workspaceId: WorkspaceIdSchema.optional().describe(
        "Target Project; omit for this Project, never Main.",
      ),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestCreationOutputSchema,
  access: "self",
  callers: ["run"] as const,
});

export const browser_tab_read = defineAgentTool({
  name: "browser_tab_read",
  title: "Find saved tabs",
  description:
    "Find open/asleep saved tabs and groups. Returns tabs, reachable groups/tabCount and nextCursor; keep query when paging. tabId is Browser Harness surfaceId; null profileId means Guest. Groups grant no access.",
  input: BrowserTabReadInputSchema,
  output: BrowserTabReadOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const browser_tab_write = defineAgentTool({
  name: "browser_tab_write",
  title: "Organize saved tabs",
  description:
    "Organize saved tabs/groups; tabId is Browser Harness surfaceId. move: omit toGroupId for root, before for end. restore: up to eight tabIds, attaching their sessions here. Returns changed groups or closed/failed/restored tab/session IDs. Groups grant no access.",
  input: BrowserTabWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserTabWriteOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
});

export const browser_session_list = defineAgentTool({
  name: "browser_session_list",
  title: "List browser sessions",
  description:
    "Find accessible persistent browser sessions, with identity, placement and attached (open here). Main inheritance includes the owner’s Project sessions. Attach with browser_session_open before driving one.",
  input: z.strictObject({}),
  output: BrowserSessionListOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const browser_session_open = defineAgentTool({
  name: "browser_session_open",
  title: "Open a browser session",
  description:
    "Attach by sessionId, or create with profileId or fresh: true (Guest); choose one. Returns session/placement and wasExisting. Drive with Browser Harness. Sessions outlive Runs; Guest data is lost on close. Identity/placed computer stay fixed. Report update/access refusals; never bypass with Guest, another profile or computer.",
  input: z
    .strictObject({
      environmentId: EnvironmentIdSchema.optional().describe(
        "Computer for an unplaced profile/Guest; defaults to this execution or the only browser. Cannot move a placed profile.",
      ),
      fresh: z
        .literal(true)
        .optional()
        .describe("New Guest session; no saved identity or persistent data."),
      profileId: BrowserProfileIdSchema.optional().describe(
        "Accessible named profile for a new session.",
      ),
      sessionId: BrowserSessionIdInputSchema.optional().describe(
        "Existing session to attach with its original identity.",
      ),
    })
    .refine(
      (input) => [input.fresh, input.profileId, input.sessionId].filter(Boolean).length === 1,
      "Choose exactly one of an existing session to attach, a granted browser profile, or a fresh session",
    )
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserSessionOpenOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
});

export const browser_profile_create = defineAgentTool({
  name: "browser_profile_create",
  title: "Create a browser profile",
  description:
    "Create an empty named identity where Main inheritance permits. List first to avoid duplicates. Returns profile.id; opens nothing and grants no Project access. Open with browser_session_open, then request sign-in. Names prove no login. Never create replacements to bypass update refusals.",
  input: z
    .strictObject({
      name: z.string().trim().min(1).max(120).describe("Short profile label, such as Work."),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserProfileCreateOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
});

export const browser_session_close = defineAgentTool({
  name: "browser_session_close",
  title: "Close a browser session",
  description:
    "Close exact sessionId for every attached execution/viewer. Returns closed/sessionId. Guest data is lost; named profile data remains.",
  input: z
    .strictObject({ sessionId: BrowserSessionIdInputSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserSessionCloseOutputSchema,
  access: "self",
  callers: ["run", "program"] as const,
  destructive: true,
});
