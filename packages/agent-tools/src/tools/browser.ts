import { defineAgentTool } from "../registry.js";
import { BrowserSurfaceIdSchema } from "@opensteer/core";

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
    "Find the owner’s browser profiles. Each home names its device and reachability; profiles open only there. If its home is offline, name the device and stop, never replace the profile. Names never prove a login. Request a profile only when none fits.",
  input: z.strictObject({}),
  output: BrowserProfileListOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const use_card = defineAgentTool({
  name: "use_card",
  title: "Request saved card use",
  description:
    "Request approval to use a saved card on this checkout site, only in the hosting computer's browser. Run-only; returns the outcome. On ready, focus each field and call fillCard(cardRef, field); values never appear in results. Never read back, print, log, copy or save card values. Approval covers filling, not permission to buy: the person's request must cover the purchase.",
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

export const copy_chrome_cookies = defineAgentTool({
  name: "copy_chrome_cookies",
  title: "Copy Chrome cookies",
  description:
    "Copy the person's Chrome cookies for a site into a browser tab, with their approval. No typing or codes, but some sites (often banks) tie a sign-in to the original browser and refuse copied cookies; use_saved_login signs in fresh instead. copied means only that cookies arrived: reload and check the account. You never see cookie values. Run-only.",
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

export const use_saved_login = defineAgentTool({
  name: "use_saved_login",
  title: "Use a saved login",
  description:
    'Use a login saved in Opensteer Passwords, with the person\'s approval. ready gives a loginRef you fill without seeing the values: in a browser, focus each field and call fillLogin(loginRef, "username" | "password" | "code"); in a genuine Mac or phone app, type {loginRef, field}. Then submit and check the account. The reference lasts about an hour, so call again to sign back in after a site logs you out. When Passwords lacks the login, is not set up or is off, Opensteer shows the person how to fix it under your reply and tells you once a login is saved; that status is true only when returned, so if the person says it is fixed or asks again, call again first. Run-only.',
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
    "Ask the person for a browser profile when none in browser_profile_list fits: they want a new one, or the work needs a separate identity. Never for an already available profile (open it), and not merely because work is signed-out: a profile still browses signed-out sites with a normal, aged identity, while a Guest tab is a brand-new browser that sites challenge more. Only the person creates or grants profiles. Suggest an existing profileId, or a new name of one or two plain words such as Brex, Work or Finance; the person may choose differently. Returns the Request outcome; open the profile it names. Pending gives no profile.",
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
