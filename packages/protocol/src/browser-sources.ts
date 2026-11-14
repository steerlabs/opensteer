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

/**
 * Version 4 scopes every operation to a schemeful site and moves the approval of
 * which site may be shared to the Host. The extension still keeps its own
 * record of shared sites so a person can stop one from Chrome.
 */
export const browserSourceProtocolVersion = 4;

export {
  browserSourceWireCurrent,
  browserSourceWireFloor,
  negotiateWire,
  parseWireQuery,
  readClientMessage,
  type BrowserSourceClientFrame,
  type BrowserSourceHostFrame,
  type UnknownMessage,
  type WireNegotiation,
} from "@opensteer/browser-source-wire/frames";

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

/** Why `copy_chrome_cookies` copied nothing; `chrome-signed-out` means no paired Chrome has the site. */
export const ChromeCookiesUnavailableReasonSchema = z.union([
  BrowserSourceExportProblemSchema.exclude(["no-state"]),
  z.enum([
    "chrome-signed-out",
    "needs-approval",
    "session-closed",
    "runtime-outdated",
    "unsupported-operation",
    "rate-limited",
    /** A loopback site or this Deployment's own site. */
    "not-allowed",
  ]),
]);
export type ChromeCookiesUnavailableReason = z.infer<typeof ChromeCookiesUnavailableReasonSchema>;

/**
 * What an agent learns from `copy_chrome_cookies`. It never carries cookie
 * values, and `copied` means only that cookies reached the session: the site
 * may still refuse them.
 */
export const ChromeCookiesResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("copied"),
    site: BrowserSiteSchema,
    sourceName: BrowserSourceNameSchema,
    /** Set when the session is profile-backed: the cookies are saved to that profile. */
    profileName: z.string().max(200).nullable(),
  }),
  z.object({
    status: z.literal("pending"),
    site: BrowserSiteSchema,
    requestId: RequestIdSchema,
    replayed: z.boolean(),
  }),
  z.object({
    status: z.literal("declined"),
    site: BrowserSiteSchema,
    requestId: RequestIdSchema,
  }),
  z.object({
    status: z.literal("unavailable"),
    site: BrowserSiteSchema,
    reason: ChromeCookiesUnavailableReasonSchema,
  }),
]);
export type ChromeCookiesResult = z.infer<typeof ChromeCookiesResultSchema>;

/** A Request's fulfilled response value. */
export const BrowserSignInRequestResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    profileName: z.string().max(200).nullable(),
    sourceName: BrowserSourceNameSchema,
  }),
  z.strictObject({ outcome: z.literal("session-closed") }),
  /** Chrome connected after the Request opened, and no Chrome has a sign-in to the site. */
  z.strictObject({ outcome: z.literal("not-signed-in") }),
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
