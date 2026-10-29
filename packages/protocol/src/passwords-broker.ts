import { BrowserSiteSchema, WorkspaceIdSchema } from "@opensteer/core";
import { z } from "zod";
import {
  PasswordSignInAvailabilitySchema,
  PasswordSignInRequesterSchema,
} from "./password-sign-in.js";

/**
 * The wire between Electron main and "Opensteer Passwords", the signed Swift
 * broker that owns the vault. Frames are 4-byte big-endian lengths followed by
 * UTF-8 JSON, over a Unix socket both ends verify by code signature. The Swift
 * side mirrors these shapes; `passwords-wire.json` pins both.
 *
 * Version 4 authorizes a pinned login without releasing credentials. Each
 * field release revalidates the live transaction, login, grant and origin.
 */
export const passwordsBrokerProtocolVersion = 4;
/** New authorities explicitly opt in; existing desktop callers keep their v4 wire. */
export const passwordsBrokerLatestProtocolVersion = 5;
export const passwordsBrokerSupportedProtocolVersions = [5, 4] as const;
export const PasswordsBrokerProtocolVersionSchema = z.union([z.literal(4), z.literal(5)]);
export const PasswordsPermissionVersionSchema = z.union([z.literal(4), z.literal(5)]);
export const passwordsBrokerMaxFrameBytes = 256 * 1_024;

export const PasswordsBrokerMethodSchema = z.enum([
  "hello",
  "status",
  "window.open",
  "signin.probe",
  "signin.request",
  "signin.approve",
  "signin.release",
  "signin.cancel",
]);
export type PasswordsBrokerMethod = z.infer<typeof PasswordsBrokerMethodSchema>;

export const PasswordsBrokerRequestEnvelopeSchema = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  method: PasswordsBrokerMethodSchema,
  params: z.record(z.string(), z.unknown()),
});
export type PasswordsBrokerRequestEnvelope = z.infer<typeof PasswordsBrokerRequestEnvelopeSchema>;

export const PasswordsBrokerErrorCodeSchema = z.enum(["invalid", "unavailable", "internal"]);
export const PasswordsBrokerReplySchema = z.union([
  z.strictObject({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    error: z.strictObject({
      code: PasswordsBrokerErrorCodeSchema,
      message: z.string().max(2_000),
    }),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    event: z.literal("status.changed"),
    params: z.record(z.string(), z.unknown()),
  }),
]);
export type PasswordsBrokerReply = z.infer<typeof PasswordsBrokerReplySchema>;

export const PasswordsBrokerEmptySchema = z.strictObject({});

export const PasswordsBrokerHelloParamsSchema = z.strictObject({
  client: z.strictObject({ version: z.string().min(1).max(64) }),
  protocolVersion: PasswordsBrokerProtocolVersionSchema,
});
export const PasswordsBrokerHelloResultSchema = z.strictObject({
  brokerVersion: z.string().min(1).max(64),
  development: z.boolean(),
  protocolVersion: PasswordsBrokerProtocolVersionSchema,
});

/**
 * `unsupported`: this Mac has no Secure Enclave or runs an unqualified macOS.
 * `needs-reset`: a vault exists that this Mac's keys cannot open (for example
 * after restoring another Mac's files, or one set up under an older key
 * policy); the person sets up again.
 */
export const PasswordsVaultStateSchema = z.enum([
  "not-set-up",
  "ready",
  "unsupported",
  "needs-reset",
]);
export type PasswordsVaultState = z.infer<typeof PasswordsVaultStateSchema>;

export const PasswordsBrokerStatusSchema = z.strictObject({
  agentSignIns: z.enum(["on", "off"]),
  vault: PasswordsVaultStateSchema,
});
export type PasswordsBrokerStatus = z.infer<typeof PasswordsBrokerStatusSchema>;

/** An HTTPS origin with a DNS name, as both the broker and the browser normalize it. */
export const PasswordsOriginSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }, "Expected an exact HTTPS origin.");

/**
 * Whether a saved login covers the site, read without prompting. Only the site:
 * no Deployment or Workspace changes the answer.
 */
export const PasswordsBrokerSignInProbeParamsSchema = z.strictObject({
  site: BrowserSiteSchema,
});
export type PasswordsBrokerSignInProbeParams = z.infer<
  typeof PasswordsBrokerSignInProbeParamsSchema
>;
export const PasswordsBrokerSignInProbeResultSchema = z.strictObject({
  passwords: PasswordSignInAvailabilitySchema,
});
export type PasswordsBrokerSignInProbeResult = z.infer<
  typeof PasswordsBrokerSignInProbeResultSchema
>;

/**
 * One sign-in, named by the Host. The Deployment, Workspace and site select a
 * grant; the names and reason are display text for the approval and Activity.
 */
export const PasswordsBrokerSignInRequestParamsSchema = z.strictObject({
  ...PasswordSignInRequesterSchema.shape,
  expiresAt: z.iso.datetime({ offset: true }),
  runtimeId: z.string().min(1).max(255),
  sessionId: z.string().min(1).max(128),
  site: BrowserSiteSchema,
  transactionId: z.uuid(),
  workspaceId: WorkspaceIdSchema,
});
export type PasswordsBrokerSignInRequestParams = z.infer<
  typeof PasswordsBrokerSignInRequestParamsSchema
>;

/** Scope is pinned on the transaction, including approvals that create no grant. */
export const PasswordsBrokerSignInRequestV5ParamsSchema = z.strictObject({
  ...PasswordSignInRequesterSchema.shape,
  protocolVersion: z.literal(5),
  // Protocol 4 stays origin-only; every protocol-5 transaction asks for consent that covers apps.
  permissionVersion: z.literal(5),
  expiresAt: z.iso.datetime({ offset: true }),
  site: BrowserSiteSchema,
  transactionId: z.uuid(),
  workspaceId: WorkspaceIdSchema,
});
export type PasswordsBrokerSignInRequestV5Params = z.infer<
  typeof PasswordsBrokerSignInRequestV5ParamsSchema
>;

/** The authorized login's public descriptor. No field value is released. */
export const PasswordsBrokerLoginSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  account: z.string().max(200),
  hasTOTP: z.boolean(),
});
export type PasswordsBrokerLogin = z.infer<typeof PasswordsBrokerLoginSchema>;

/** A saved login the person can choose for a site; never its password. */
export const PasswordsBrokerAccountSchema = z.strictObject({
  host: z.string().min(1).max(253),
  id: z.uuid(),
  onPage: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
  label: z.string().min(1).max(200).nullable(),
  revision: PasswordsBrokerLoginSchema.shape.revision,
  username: z.string().max(1_024),
});
export type PasswordsBrokerAccount = z.infer<typeof PasswordsBrokerAccountSchema>;
export const PasswordsBrokerAccountsSchema = z.array(PasswordsBrokerAccountSchema).max(100);

const PasswordsBrokerAuthorizedDecisionSchema = z.strictObject({
  decision: z.literal("authorized"),
  login: PasswordsBrokerLoginSchema,
});

/** Nothing may be released now; the sign-in has ended, so no transaction remains. */
const PasswordsBrokerUnavailableReasonSchema = z.enum(["passwords-off", "not-set-up", "busy"]);

/**
 * `authorized`: a grant for this Deployment, Workspace and site authorized its
 * login without asking. `approve`: the person chooses among the site's saved
 * accounts, which may be none. Both decisions release no field values.
 */
export const PasswordsBrokerSignInDecisionSchema = z.discriminatedUnion("decision", [
  PasswordsBrokerAuthorizedDecisionSchema,
  z.strictObject({
    accounts: PasswordsBrokerAccountsSchema,
    decision: z.literal("approve"),
  }),
  z.strictObject({
    decision: z.literal("unavailable"),
    reason: PasswordsBrokerUnavailableReasonSchema,
  }),
]);
export type PasswordsBrokerSignInDecision = z.infer<typeof PasswordsBrokerSignInDecisionSchema>;

export const PasswordsBrokerTransactionParamsSchema = z.strictObject({ transactionId: z.uuid() });

/**
 * Allow (`remember`, which grants the login to this Workspace for the site) or
 * Only this time. The broker authenticates the person for exactly this login
 * at this revision; a cancelled or failed authentication is an `invalid` error
 * whose message the card shows, and the card stays.
 */
export const PasswordsBrokerSignInApproveParamsSchema = z.strictObject({
  loginId: PasswordsBrokerAccountSchema.shape.id,
  remember: z.boolean(),
  revision: PasswordsBrokerAccountSchema.shape.revision,
  transactionId: z.uuid(),
});
/**
 * `authorized`: authorized (and with `remember`, granted). `approve`: the chosen
 * login changed or is gone, so nothing was released or granted; these are the
 * site's accounts now, which the card offers instead, with `message` (one plain
 * sentence) saying why. `unavailable`: agent sign-ins are off or Passwords is
 * not ready; the sign-in has ended, as a refused request has.
 */
export const PasswordsBrokerSignInApproveResultSchema = z.discriminatedUnion("decision", [
  PasswordsBrokerAuthorizedDecisionSchema,
  z.strictObject({
    accounts: PasswordsBrokerAccountsSchema,
    decision: z.literal("approve"),
    message: z.string().min(1).max(200),
  }),
  z.strictObject({
    decision: z.literal("unavailable"),
    reason: PasswordsBrokerUnavailableReasonSchema.exclude(["busy"]),
  }),
]);
export type PasswordsBrokerSignInApproveResult = z.infer<
  typeof PasswordsBrokerSignInApproveResultSchema
>;

export const PasswordsBrokerSignInReleaseParamsSchema = z.strictObject({
  transactionId: z.uuid(),
  field: z.enum(["username", "password", "totp"]),
  origin: PasswordsOriginSchema,
});
export type PasswordsBrokerSignInReleaseParams = z.infer<
  typeof PasswordsBrokerSignInReleaseParamsSchema
>;
/** An app release is explicit; omitting origin on a v4 release never widens consent. */
export const PasswordsBrokerSignInReleaseV5ParamsSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    transactionId: z.uuid(),
    field: PasswordsBrokerSignInReleaseParamsSchema.shape.field,
    kind: z.literal("app"),
  }),
  PasswordsBrokerSignInReleaseParamsSchema.extend({ kind: z.literal("browser") }),
]);
export type PasswordsBrokerSignInReleaseV5Params = z.infer<
  typeof PasswordsBrokerSignInReleaseV5ParamsSchema
>;
export const PasswordsBrokerSignInReleaseResultSchema = z.discriminatedUnion("released", [
  z.strictObject({ released: z.literal(true), value: z.string().max(4_096) }),
  z.strictObject({
    released: z.literal(false),
    reason: z.enum(["ended", "revoked", "wrong-site", "no-totp", "passwords-off"]),
  }),
]);
export type PasswordsBrokerSignInReleaseResult = z.infer<
  typeof PasswordsBrokerSignInReleaseResultSchema
>;

/** Each method's parameters, as Electron main sends them. */
export const passwordsBrokerRequests = {
  hello: PasswordsBrokerHelloParamsSchema,
  "signin.approve": PasswordsBrokerSignInApproveParamsSchema,
  "signin.cancel": PasswordsBrokerTransactionParamsSchema,
  "signin.probe": PasswordsBrokerSignInProbeParamsSchema,
  "signin.request": z.union([
    PasswordsBrokerSignInRequestParamsSchema,
    PasswordsBrokerSignInRequestV5ParamsSchema,
  ]),
  "signin.release": z.union([
    PasswordsBrokerSignInReleaseParamsSchema,
    PasswordsBrokerSignInReleaseV5ParamsSchema,
  ]),
  status: PasswordsBrokerEmptySchema,
  "window.open": PasswordsBrokerEmptySchema,
} as const satisfies Record<PasswordsBrokerMethod, z.ZodType>;

/** Each method's result, as the broker answers it. */
export const passwordsBrokerResults = {
  hello: PasswordsBrokerHelloResultSchema,
  "signin.approve": PasswordsBrokerSignInApproveResultSchema,
  "signin.cancel": PasswordsBrokerEmptySchema,
  "signin.probe": PasswordsBrokerSignInProbeResultSchema,
  "signin.request": PasswordsBrokerSignInDecisionSchema,
  "signin.release": PasswordsBrokerSignInReleaseResultSchema,
  status: PasswordsBrokerStatusSchema,
  "window.open": PasswordsBrokerEmptySchema,
} as const satisfies Record<PasswordsBrokerMethod, z.ZodType>;

export const PasswordsBrokerStatusChangedEventSchema = z.strictObject({
  event: z.literal("status.changed"),
  params: PasswordsBrokerStatusSchema,
});
