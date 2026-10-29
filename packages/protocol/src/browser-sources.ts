import { z } from "zod";
import {
  BrowserSourceChallengeSchema,
  BrowserSourceDestinationSchema,
} from "@opensteer/deployment-authority";
import {
  BrowserSiteSchema,
  BrowserSourceIdSchema,
  IsoDateTimeSchema,
  RequestIdSchema,
  WorkspaceIdSchema,
} from "@opensteer/core";
import {
  BrowserSourceSnapshotSchema,
  maxBrowserSourceSnapshotBytes,
} from "@opensteer/browser-profile/source-state";
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
export const maxBrowserSourceFrameBytes = maxBrowserSourceSnapshotBytes + 64 * 1_024;
export const BrowserSourceNameSchema = z.string().trim().min(1).max(120);

/**
 * What a connected Chrome reports about one site.
 * - `no-state`: this Chrome profile has no sign-in cookies for the site.
 * - `stopped`: the person chose Stop sharing for this site in the extension.
 * - `chrome-blocked`: Chrome's site access for the extension excludes the site.
 * - `limit`: the extension's daily budget of newly shared sites is spent.
 */
export const BrowserSourceStatusSchema = z.enum([
  "available",
  "no-state",
  "stopped",
  "chrome-blocked",
  "limit",
  "unsupported",
  "too-large",
]);
export type BrowserSourceStatus = z.infer<typeof BrowserSourceStatusSchema>;
export type BrowserSourceExportProblem = Exclude<BrowserSourceStatus, "available">;
const BrowserSourceExportProblemSchema = BrowserSourceStatusSchema.exclude(["available"]);

export const BrowserSourceSummarySchema = z.object({
  connected: z.boolean(),
  createdAt: IsoDateTimeSchema,
  id: BrowserSourceIdSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  name: BrowserSourceNameSchema,
});
export type BrowserSourceSummary = z.infer<typeof BrowserSourceSummarySchema>;

/** A site a Workspace's agents may sign in to without asking again. */
export const BrowserSiteGrantSchema = z.object({
  createdAt: IsoDateTimeSchema,
  lastSignedInAt: IsoDateTimeSchema.nullable(),
  preferredSourceId: BrowserSourceIdSchema.nullable(),
  site: BrowserSiteSchema,
  workspaceId: WorkspaceIdSchema,
});
export type BrowserSiteGrant = z.infer<typeof BrowserSiteGrantSchema>;

export const BrowserSourcesStateSchema = z.object({
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

/**
 * The outcome of signing a live Browser Session in with a Chrome sign-in, as
 * the owner sees it. Anything but `applied` leaves the session unchanged.
 * - `no-chrome`: no Chrome profile is connected.
 * - `chrome-offline`: the chosen Chrome profile is not connected right now.
 * - `choose-source`: several Chrome profiles are signed in; name one.
 * - `session-closed`: the Browser Session ended.
 * - `runtime-outdated`: the browser running the session predates live sign-in.
 * - `not-allowed`: the site can never be signed in: a loopback address, or the
 *   site of this Deployment's own address (its session cookie lives there).
 * - `site-removed`: the site was removed from the Workspace's allowed sites
 *   while the sign-in was in flight; allowing it again retries.
 */
export const BrowserSignInProblemSchema = z.union([
  BrowserSourceExportProblemSchema,
  z.enum([
    "no-chrome",
    "chrome-offline",
    "choose-source",
    "session-closed",
    "runtime-outdated",
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
  /** Read-only historical result. The site's cookies were handed to the session; the agent reloads and checks the account. */
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
    replayed: z.boolean(),
    requestId: RequestIdSchema,
    status: z.literal("pending"),
    waitingFor: PasswordSignInNeedSchema.optional(),
  }),
  z.object({ requestId: RequestIdSchema, status: z.literal("declined") }),
  /** A repeated call whose Request already ended; its continuation carries the result. */
  z.object({ requestId: RequestIdSchema, status: z.literal("resolved") }),
  z.object({ site: BrowserSiteSchema, status: z.literal("not-signed-in") }),
  z.object({
    reason: BrowserSignInUnavailableReasonSchema,
    site: BrowserSiteSchema,
    status: z.literal("unavailable"),
  }),
]);
export type AgentBrowserSignInResult = z.infer<typeof AgentBrowserSignInResultSchema>;

/** A Request's fulfilled response value. */
export const BrowserSignInRequestResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    profileName: z.string().max(200).nullable(),
    sourceName: BrowserSourceNameSchema,
  }),
  z.strictObject({ outcome: z.literal("session-closed") }),
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

export const BrowserSourcePairInputSchema = BrowserSourceDestinationSchema.extend({
  code: z.string().min(32).max(128),
  name: BrowserSourceNameSchema,
  /**
   * Reconnecting the same Chrome profile retires its previous connection
   * atomically, so grants that preferred it follow the new one.
   */
  replaces: z
    .strictObject({ sourceId: BrowserSourceIdSchema, token: z.string().min(32).max(256) })
    .nullable(),
  version: z.number().int().positive(),
});
/** `POST /internal/v1/browser-sources/pair/challenge`, answered before any secret is sent. */
export const BrowserSourcePairChallengeResultSchema = z.strictObject({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export const BrowserSourcePairResultSchema = z.object({
  sourceId: BrowserSourceIdSchema,
  token: z.string().min(32).max(256),
});

const operationFields = { operationId: z.uuid(), site: BrowserSiteSchema };
export const BrowserSourceHostMessageSchema = z.discriminatedUnion("type", [
  z.discriminatedUnion("code", [
    z.strictObject({
      type: z.literal("source.error"),
      code: z.literal("unsupported-version"),
      supportedVersion: z.number().int().positive(),
    }),
    z.strictObject({
      type: z.literal("source.error"),
      code: z.literal("route-changed"),
      /**
       * Present when sent before the connection proof: a Host signature over
       * the source's challenge (`browserSourceRouteChangedBytes`). The
       * extension ignores an unsigned pre-proof notice.
       */
      signature: z
        .string()
        .regex(/^[A-Za-z0-9_-]{86}$/u)
        .optional(),
    }),
    z.strictObject({
      type: z.literal("source.error"),
      code: z.literal("source-unauthorized"),
    }),
  ]),
  z.strictObject({
    nonce: z.uuid(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
    type: z.literal("source.proof"),
  }),
  z.strictObject({ type: z.literal("source.ready"), sourceId: BrowserSourceIdSchema }),
  z.strictObject({ ...operationFields, type: z.literal("source.inspect") }),
  z.strictObject({ ...operationFields, type: z.literal("source.export") }),
  z.strictObject({ nonce: z.uuid(), type: z.literal("ping") }),
]);
export type BrowserSourceHostMessage = z.infer<typeof BrowserSourceHostMessageSchema>;
export const BrowserSourceClientMessageSchema = z.discriminatedUnion("type", [
  BrowserSourceChallengeSchema.extend({
    type: z.literal("source.challenge"),
  }),
  z.strictObject({
    sourceId: BrowserSourceIdSchema,
    token: z.string().min(32).max(256),
    type: z.literal("source.hello"),
    version: z.number().int().positive(),
  }),
  z.strictObject({
    operationId: z.uuid(),
    status: BrowserSourceStatusSchema,
    type: z.literal("source.inspect.result"),
  }),
  z.strictObject({
    operationId: z.uuid(),
    result: z.discriminatedUnion("status", [
      z.strictObject({ snapshot: BrowserSourceSnapshotSchema, status: z.literal("exported") }),
      z.strictObject({ status: BrowserSourceExportProblemSchema }),
    ]),
    type: z.literal("source.export.result"),
  }),
  z.strictObject({ nonce: z.uuid(), type: z.literal("pong") }),
  /**
   * The person chose Disconnect in Chrome. The Host revokes this source exactly
   * as the owner's Disconnect in Opensteer does, then closes the socket.
   */
  z.strictObject({ type: z.literal("source.disconnect") }),
]);
export type BrowserSourceClientMessage = z.infer<typeof BrowserSourceClientMessageSchema>;

/**
 * The Opensteer extension's Chrome ID, fixed by the public `key` in its
 * manifest so web pages can detect it and open its connect page. The extension
 * build checks that the manifest key still derives this ID.
 */
export const opensteerChromeExtensionId = "oikoblakkddmchfnkdmhfcnljnadohkp";
