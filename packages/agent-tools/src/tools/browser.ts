import { defineAgentTool } from "../registry.js";
import { BrowserProfileIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, BrowserAccessSuggestionInputSchema } from "./inputs.js";
import {
  BrowserProfileListOutputSchema,
  CopyChromeCookiesOutputSchema,
  UseSavedLoginOutputSchema,
  UseCardOutputSchema,
  RequestCreationOutputSchema,
} from "./outputs.js";
export const browser_profile_list = defineAgentTool({
  name: "browser_profile_list",
  title: "List browser profiles",
  description:
    "List the person's browser profiles and the sites whose Chrome cookies they let Opensteer copy. Each profile opens only on its home computer; if that computer is offline, name it and stop, never substitute another profile. A profile's name never proves a login. Ask with browser_profile_request only when none fits.",
  input: z.strictObject({}),
  output: BrowserProfileListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const browser_profile_update = defineAgentTool({
  name: "browser_profile_update",
  title: "Rename a browser profile",
  description: "Rename one of the person's browser profiles.",
  input: z.strictObject({
    profileId: BrowserProfileIdSchema,
    name: z.string().trim().min(1).max(120),
  }),
  output: z.object({
    ok: z.literal(true),
    profile: z.object({ id: BrowserProfileIdSchema, name: z.string() }).optional(),
  }),
  access: "settings",
  callers: ["run", "connection"] as const,
});

export const browser_profile_remove = defineAgentTool({
  name: "browser_profile_remove",
  title: "Remove browser data",
  description:
    "Delete a browser profile, clear its history, remove one history URL, or forget a remembered site so its cookies are no longer copied. New profiles, sign-in and pairing need the person.",
  input: z
    .strictObject({
      target: z.enum(["profile", "history", "history_url", "site"]),
      profileId: BrowserProfileIdSchema.optional().describe(
        "profile, history and history_url: the profile.",
      ),
      url: z.string().min(1).max(2048).optional().describe("history_url: the exact URL."),
      site: z.string().min(1).max(2048).optional().describe("site: the remembered site."),
    })
    .superRefine((input, context) => {
      const needs = {
        profileId: input.target !== "site",
        url: input.target === "history_url",
        site: input.target === "site",
      };
      for (const [field, needed] of Object.entries(needs))
        if (needed !== (input[field as keyof typeof needs] !== undefined))
          context.addIssue({
            code: "custom",
            message: needed ? `${field} is required for this target` : `${field} is not used`,
            path: [field],
          });
    }),
  output: z.object({
    ok: z.literal(true),
    deletion: z.object({ profileId: BrowserProfileIdSchema, state: z.string() }).optional(),
  }),
  access: "settings",
  callers: ["run", "connection"] as const,
  destructive: true,
});

export const card_request = defineAgentTool({
  name: "card_request",
  title: "Request a saved card",
  description:
    "Ask the person to approve a saved card for this checkout site, in the hosting computer's browser only. On ready, focus each field and call fillCard(cardRef, field); values never appear in results. Never read back, print, log, copy or save card values. Approval covers filling, not permission to buy: the person's request must cover the purchase.",
  input: z.strictObject({
    site: z.string().trim().min(1).max(2048),
    reason: z.string().trim().min(1).max(500),
    tabId: BrowserSurfaceIdSchema,
    operationKey: OperationKeySchema.optional(),
  }),
  output: UseCardOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

const SiteInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .describe("Site whose login is needed, such as github.com. Covers its subdomains.");
const ReasonInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("Why this task needs the account.");

export const chrome_cookies_request = defineAgentTool({
  name: "chrome_cookies_request",
  title: "Request Chrome cookies",
  description:
    "Sign in by copying the person's Chrome cookies for a site into a browser tab, with their approval. No typing or codes, but some sites (often banks) tie a login to the original browser and refuse copied cookies; saved_login_request signs in fresh instead. copied means only that cookies arrived: reload and check the account. You never see cookie values.",
  input: z
    .strictObject({
      reason: ReasonInputSchema,
      tabId: BrowserSurfaceIdSchema.describe("Browser tab to receive the cookies."),
      site: SiteInputSchema,
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: CopyChromeCookiesOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const saved_login_request = defineAgentTool({
  name: "saved_login_request",
  title: "Request a saved login",
  description:
    'Sign in with a login and password saved in Opensteer Passwords, with the person\'s approval. ready gives a loginRef you fill without seeing the values: in a browser, focus each field and call fillLogin(loginRef, "username" | "password" | "code"); in a genuine Mac or phone app, type {loginRef, field}. Then submit and check the account. The reference lasts about an hour, so call again to sign back in after a site logs you out. When Passwords lacks the login, is not set up or is off, Opensteer shows the person how to fix it under your reply and tells you once a login is saved; that status is true only when returned, so if the person says it is fixed or asks again, call again first.',
  input: z
    .strictObject({
      reason: ReasonInputSchema,
      tabId: BrowserSurfaceIdSchema.optional().describe(
        "Browser tab showing the site's sign-in form; omit for a genuine app.",
      ),
      site: SiteInputSchema,
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: UseSavedLoginOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const browser_profile_request = defineAgentTool({
  name: "browser_profile_request",
  title: "Request a browser profile",
  description:
    "Ask the person for a browser profile when none in browser_profile_list fits: they want a new one, or the work needs a separate identity. Never for an already available profile (open it), and not merely because work is signed-out: a profile still browses signed-out sites with a normal, aged identity, while a Guest tab is a brand-new browser that sites challenge more. Only the person creates or grants profiles. Suggest an existing profileId, or a new name of one or two plain words such as Brex, Work or Finance; the person may choose differently. When the Request is fulfilled, open the profile it names; pending gives no profile.",
  input: z
    .strictObject({
      reason: z.string().trim().min(1).max(500).describe("Why this task needs the profile."),
      suggestion: BrowserAccessSuggestionInputSchema,
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const browserTools = [
  browser_profile_list,
  browser_profile_update,
  browser_profile_remove,
  browser_profile_request,
  saved_login_request,
  chrome_cookies_request,
  card_request,
] as const;
