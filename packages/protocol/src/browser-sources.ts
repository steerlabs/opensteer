import { z } from "zod";
import {
  BrowserSiteSchema,
  BrowserSourceIdSchema,
  IsoDateTimeSchema,
  RequestIdSchema,
} from "@opensteer/core";
import {
  BrowserSourceExportProblemSchema,
  BrowserSourceNameSchema,
  BrowserSourceStatusSchema,
} from "@opensteer/browser-source-wire/frames";
import {
  LoginRefSchema,
  PasswordSignInFailureReasonSchema,
  PasswordSignInMethodSchema,
  PasswordSignInNeedSchema,
} from "./password-sign-in.js";

/**
 * Version 4 scopes every operation to a schemeful site and moves the approval of
 * which site may be shared to the Host. The extension still keeps its own
 * record of shared sites so a person can stop one from Chrome.
 */
export const browserSourceProtocolVersion = 4;

export {
  BrowserSourceClientMessageV4Schema as BrowserSourceClientMessageSchema,
  BrowserSourceHostMessageV4Schema as BrowserSourceHostMessageSchema,
  BrowserSourceNameSchema,
  BrowserSourcePairChallengeResultSchema,
  BrowserSourcePairInputSchema,
  BrowserSourcePairResultSchema,
  BrowserSourceStatusSchema,
  maxBrowserSourceFrameBytes,
  type BrowserSourceClientMessageV4 as BrowserSourceClientMessage,
  type BrowserSourceExportProblem,
  type BrowserSourceHostMessageV4 as BrowserSourceHostMessage,
  type BrowserSourceStatus,
} from "@opensteer/browser-source-wire/frames";

export const BrowserSourceSummarySchema = z.object({
  connected: z.boolean(),
  createdAt: IsoDateTimeSchema,
  id: BrowserSourceIdSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  name: BrowserSourceNameSchema,
});
export type BrowserSourceSummary = z.infer<typeof BrowserSourceSummarySchema>;

export const BrowserSiteGrantSchema = z.object({
  createdAt: IsoDateTimeSchema,
  lastSignedInAt: IsoDateTimeSchema.nullable(),
  preferredSourceId: BrowserSourceIdSchema.nullable(),
  site: BrowserSiteSchema,
});
export type BrowserSiteGrant = z.infer<typeof BrowserSiteGrantSchema>;

export const BrowserSourcesStateSchema = z.object({
  /** The unpacked extension folder Opensteer's desktop app keeps current on the Host's computer. */
  extensionDirectory: z.string().min(1).max(4_096).nullable().default(null),
  sites: z.array(BrowserSiteGrantSchema).max(1_024),
  sources: z.array(BrowserSourceSummarySchema).max(64),
});
export type BrowserSourcesState = z.infer<typeof BrowserSourcesStateSchema>;

/** Live availability of one site across the owner's Chrome profiles. */
export const BrowserSourceInspectionSchema = z.object({
  candidates: z
    .array(
      z.object({
        name: BrowserSourceNameSchema,
        sourceId: BrowserSourceIdSchema,
        status: z.union([BrowserSourceStatusSchema, z.literal("offline")]),
      }),
    )
    .max(64),
  site: BrowserSiteSchema,
});
export type BrowserSourceInspection = z.infer<typeof BrowserSourceInspectionSchema>;

export const BrowserSignInProblemSchema = z.union([
  BrowserSourceExportProblemSchema,
  z.enum([
    "no-chrome",
    "chrome-offline",
    "choose-source",
    "session-closed",
    "runtime-outdated",
    "unsupported-operation",
    "not-allowed",
    "site-removed",
  ]),
]);
export type BrowserSignInProblem = z.infer<typeof BrowserSignInProblemSchema>;

export const BrowserSignInOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    /** Set when the session is profile-backed: the sign-in is saved to that profile. */
    profileName: z.string().max(200).nullable(),
    site: BrowserSiteSchema,
    sourceName: BrowserSourceNameSchema,
    status: z.literal("applied"),
  }),
  z.object({
    problem: BrowserSignInProblemSchema,
    site: BrowserSiteSchema,
    /** The Chrome profile the problem concerns, when there is exactly one. */
    sourceName: BrowserSourceNameSchema.nullable(),
    status: z.literal("problem"),
  }),
]);
export type BrowserSignInOutcome = z.infer<typeof BrowserSignInOutcomeSchema>;

/**
 * What an agent learns from `sign_in`. It never carries cookie values.
 * `pending` means an owner Request is open: it completes by itself when the
 * owner allows it and a connected Chrome can supply the sign-in, or, for a
 * saved password, when what it is `waitingFor` is done.
 */
export const BrowserSignInUnavailableReasonSchema = z.enum([
  "needs-approval",
  /** Another Run's sign-in to this session/site needs the person; try again later. */
  "busy",
  "stopped",
  "chrome-blocked",
  "limit",
  "unsupported",
  "too-large",
  "session-closed",
  "runtime-outdated",
  "unsupported-operation",
  "main-browser-required",
  "rate-limited",
  /** A loopback site or this Deployment's own site; see `BrowserSignInProblemSchema`. */
  "not-allowed",
  /** Saved-password sign-ins go only into a fresh session, never one with a saved profile. */
  "needs-fresh-session",
  /** A `code` arrived but no sign-in of this Run's for the session and site waits for one. */
  "no-code-expected",
  "passwords-off",
  "passwords-not-set-up",
  "passwords-not-responding",
  "no-saved-login",
  "expired",
  "interrupted",
]);
export type BrowserSignInUnavailableReason = z.infer<typeof BrowserSignInUnavailableReasonSchema>;
/** What Opensteer Passwords needs before it could sign in; absent, it can't be offered at all. */
export const BrowserSignInPasswordsSchema = z.enum(["no-login", "not-set-up", "off"]);
export type BrowserSignInPasswords = z.infer<typeof BrowserSignInPasswordsSchema>;
export const AgentBrowserSignInResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    site: BrowserSiteSchema,
    loginRef: LoginRefSchema,
    account: z.string().max(200),
  }),
  z.object({
    profileName: z.string().max(200).nullable(),
    site: BrowserSiteSchema,
    sourceName: BrowserSourceNameSchema,
    status: z.literal("applied"),
  }),

  z.object({
    method: PasswordSignInMethodSchema,
    site: BrowserSiteSchema,
    status: z.literal("signed-in"),
  }),
  z.object({
    reason: PasswordSignInFailureReasonSchema,
    site: BrowserSiteSchema,
    status: z.literal("failed"),
  }),
  /** The site sent the person a one-time code; the sign-in waits for it until `expiresAt`. */
  z.object({
    expiresAt: IsoDateTimeSchema,
    site: BrowserSiteSchema,
    status: z.literal("needs-code"),
  }),
  z.object({
    passwords: BrowserSignInPasswordsSchema.optional(),
    replayed: z.boolean(),
    requestId: RequestIdSchema,
    status: z.literal("pending"),
    waitingFor: PasswordSignInNeedSchema.optional(),
  }),
  z.object({ requestId: RequestIdSchema, status: z.literal("declined") }),
  /** The Request ended; its outcome accompanies the tool result or a later continuation. */
  z.object({ requestId: RequestIdSchema, status: z.literal("resolved") }),
  z.object({
    passwords: BrowserSignInPasswordsSchema.optional(),
    site: BrowserSiteSchema,
    status: z.literal("not-signed-in"),
  }),
  z.object({
    reason: BrowserSignInUnavailableReasonSchema,
    site: BrowserSiteSchema,
    status: z.literal("unavailable"),
  }),
]);
export type AgentBrowserSignInResult = z.infer<typeof AgentBrowserSignInResultSchema>;

/** What a sign-in result says Opensteer Passwords lacks, or null when it can't help. */
export function browserSignInPasswordsNeed(
  result: AgentBrowserSignInResult,
): BrowserSignInPasswords | null {
  if ("passwords" in result && result.passwords !== undefined) return result.passwords;
  if (result.status !== "unavailable") return null;
  switch (result.reason) {
    case "no-saved-login":
      return "no-login";
    case "passwords-off":
      return "off";
    case "passwords-not-set-up":
      return "not-set-up";
    default:
      return null;
  }
}

/** A Request's fulfilled response value. */
export const BrowserSignInRequestResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    profileName: z.string().max(200).nullable(),
    sourceName: BrowserSourceNameSchema,
  }),
  z.strictObject({ outcome: z.literal("session-closed") }),
  /** Chrome connected after the Request opened, and no Chrome has a sign-in to the site. */
  z.strictObject({
    outcome: z.literal("not-signed-in"),
    passwords: BrowserSignInPasswordsSchema.optional(),
  }),
]);
export type BrowserSignInRequestResponse = z.infer<typeof BrowserSignInRequestResponseSchema>;

export const BrowserSignInDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("allow"), sourceId: BrowserSourceIdSchema }),
  z.strictObject({ decision: z.literal("decline") }),
]);
export type BrowserSignInDecision = z.infer<typeof BrowserSignInDecisionSchema>;

export const BrowserSourcePairingSchema = z.object({
  /** One-use; pass it to the extension's connect page or the Host's `/connect/chrome` page. */
  invitation: z.string().max(16_384),
  /** Unsigned view of the invitation's destinations, for choosing which page to open. */
  destinations: z
    .array(z.object({ origin: z.url(), remote: z.boolean() }))
    .min(1)
    .max(2),
  expiresAt: IsoDateTimeSchema,
});
export type BrowserSourcePairing = z.infer<typeof BrowserSourcePairingSchema>;

/**
 * The Opensteer extension's Chrome ID, fixed by the public `key` in its
 * manifest so web pages can detect it and open its connect page. The extension
 * build checks that the manifest key still derives this ID.
 */
export const opensteerChromeExtensionId = "oikoblakkddmchfnkdmhfcnljnadohkp";
