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
  UseCardOutputSchema,
  RequestCreationOutputSchema,
  BrowserTabReadOutputSchema,
  BrowserTabWriteOutputSchema,
  BrowserSessionListOutputSchema,
  BrowserSessionOpenOutputSchema,
  BrowserSessionCloseOutputSchema,
} from "./outputs.js";
export const browser_profile_list = defineAgentTool({
  name: "browser_profile_list",
  title: "List browser profiles",
  description:
    "Find browser profiles this Workspace can use: every owner profile in Main, granted ones in a Project. Each home names its device and reachability; profiles open only there. If its home is offline, name the device and stop, never replace the profile. Names never prove a login. Request a profile only when none fits.",
  input: z.strictObject({}),
  output: BrowserProfileListOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const use_card = defineAgentTool({
  name: "use_card",
  title: "Request saved card use",
  description:
    "Request approval to use a saved card on this checkout site, only in the main computer's browser. Run-only; returns the outcome. On ready, focus each field and call fillCard(cardRef, field); values never appear in results. Never read back, print, log, copy or save card values. Approval covers filling, not permission to buy: the person's request must cover the purchase.",
  input: z.strictObject({
    site: z.string().trim().min(1).max(2048),
    reason: z.string().trim().min(1).max(500),
    sessionId: BrowserSessionIdInputSchema,
    operationKey: OperationKeySchema.optional(),
  }),
  output: UseCardOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const sign_in = defineAgentTool({
  name: "sign_in",
  title: "Request sign-in",
  description:
    "Request saved-login or Chrome sign-in authorization. Saved passwords fill websites only in the main computer's browser. Run-only; returns the outcome. Only a passwords field means Passwords can help, and says what it needs. Do not poll, repeat or route around the Request. Use ready loginRef only for sealed field filling; never read/reveal credentials. Verify the account. Open a website sign-in page first; omit sessionId for a genuine Mac/phone app.",
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
  access: "write",
  callers: ["run"] as const,
});

export const browser_profile_request = defineAgentTool({
  name: "browser_profile_request",
  title: "Request a browser profile",
  description:
    "Ask the person for a browser profile when none in browser_profile_list fits: they want a new one, the work needs a separate identity, or a Project lacks the profile it needs (from Main, pass its workspaceId). Never for signed-out work (open fresh: true) or a profile the target Workspace can already use (open it). Only the person creates or grants profiles. Suggest an existing profileId, or a new name of one or two plain words such as Brex, Work or Finance; the person may choose differently. Returns the Request outcome; open the profile it names. Pending gives no profile.",
  input: z
    .strictObject({
      reason: z.string().trim().min(1).max(500).describe("Why this task needs the profile."),
      suggestion: BrowserAccessSuggestionInputSchema,
      workspaceId: WorkspaceIdSchema.optional().describe(
        "Workspace that needs the profile; omit for this one.",
      ),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestCreationOutputSchema,
  access: "write",
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
  callers: ["run"] as const,
});

export const browser_tab_write = defineAgentTool({
  name: "browser_tab_write",
  title: "Organize saved tabs",
  description:
    "Organize saved tabs/groups; tabId is Browser Harness surfaceId. move: omit toGroupId for root, before for end. restore: up to eight tabIds, attaching their sessions here; use each returned sessionId with its tabId, since a restore can start a new session. Returns changed groups or closed/failed/restored tab/session IDs. Groups grant no access.",
  input: BrowserTabWriteInputSchema.safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: BrowserTabWriteOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const browser_session_list = defineAgentTool({
  name: "browser_session_list",
  title: "List browser sessions",
  description:
    "Find accessible persistent browser sessions, with identity, placement and attached (open here). Main inheritance includes the owner’s Project sessions. Attach with browser_session_open before driving one.",
  input: z.strictObject({}),
  output: BrowserSessionListOutputSchema,
  access: "read",
  callers: ["run"] as const,
});

export const browser_session_open = defineAgentTool({
  name: "browser_session_open",
  title: "Open a browser session",
  description:
    "Attach by sessionId, or create with profileId or fresh: true (Guest); choose one. A profile opens only on its home, regardless of environmentId. Guest needs a browser computer running agents. Returns session/placement and wasExisting. Sessions outlive Runs; Guest data is lost on close. Name an offline home; never bypass a refusal with Guest, another profile or computer.",
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
  access: "write",
  callers: ["run"] as const,
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
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});
