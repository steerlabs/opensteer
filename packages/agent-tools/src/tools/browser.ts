import { defineAgentTool } from "../registry.js";
import { BrowserSurfaceIdSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, BrowserAccessSuggestionInputSchema } from "./inputs.js";
import {
  BrowserProfileListOutputSchema,
  SignInOutputSchema,
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

export const sign_in = defineAgentTool({
  name: "sign_in",
  title: "Request sign-in",
  description:
    "Request saved-login or Chrome sign-in authorization. Saved passwords fill websites only in the hosting computer's browser. Run-only; returns the outcome. Only a passwords field means Passwords can help, and says what it needs. Do not poll, repeat or route around the Request. Use ready loginRef only for sealed field filling; never read/reveal credentials. Verify the account. Open a website sign-in page first; omit tabId for a genuine Mac/phone app.",
  input: z
    .strictObject({
      reason: z.string().trim().min(1).max(500).describe("Why this task needs the account."),
      tabId: BrowserSurfaceIdSchema.optional().describe(
        "Website tab on its sign-in page; omit for a genuine app.",
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
    "Ask the person for a browser profile when none in browser_profile_list fits: they want a new one, or the work needs a separate identity. Never for signed-out work (open a Guest tab) or an already available profile (open it). Only the person creates or grants profiles. Suggest an existing profileId, or a new name of one or two plain words such as Brex, Work or Finance; the person may choose differently. Returns the Request outcome; open the profile it names. Pending gives no profile.",
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
