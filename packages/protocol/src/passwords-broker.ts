import {
  CardApprovalSchema,
  CardAvailabilitySchema,
  CardChoicesSchema,
  CardFieldSchema,
  CardPublicSchema,
} from "./card-use.js";
import {
  PasswordsBrokerAccountSchema,
  PasswordsBrokerAccountsSchema,
} from "./password-sign-in-accounts.js";
import { BrowserSiteSchema, WorkspaceIdSchema } from "@opensteer/core";
import { z } from "zod";
import {
  PasswordSignInAvailabilitySchema,
  PasswordSignInRequesterSchema,
} from "./password-sign-in.js";
import { PersonFillPresenceSchema } from "./person-fill.js";

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
/**
 * Current authorities explicitly negotiate 8, and 7 with a broker that has no
 * person fill; legacy read/release callers retain their scope.
 */
export const passwordsBrokerLatestProtocolVersion = 8;
export const passwordsBrokerSupportedProtocolVersions = [8, 7, 6, 5, 4] as const;
export const PasswordsBrokerProtocolVersionSchema = z.union([
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
]);
export const PasswordsPermissionVersionSchema = z.union([z.literal(4), z.literal(5)]);
export const passwordsBrokerMaxFrameBytes = 256 * 1_024;

export const PasswordsBrokerMethodSchema = z.enum([
  "card.probe",
  "card.request",
  "card.approve",
  "card.release",
  "fill.accounts",
  "fill.begin",
  "hello",
  "status",
  "window.open",
  "signin.probe",
  "signin.request",
  "signin.approve",
  "signin.commit",
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

/** `personFill` is sent only on protocol 8 connections; absent, the broker has no person fill. */
export const PasswordsBrokerStatusSchema = z.strictObject({
  agentSignIns: z.enum(["on", "off"]),
  personFill: z.enum(["on", "off"]).optional(),
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
export const PasswordsBrokerSignInRequestV6ParamsSchema = z.strictObject({
  ...PasswordSignInRequesterSchema.shape,
  protocolVersion: z.literal(6),
  // Protocol 4 stays origin-only; every modern transaction asks for consent that covers apps.
  permissionVersion: z.literal(5),
  expiresAt: z.iso.datetime({ offset: true }),
  site: BrowserSiteSchema,
  transactionId: z.uuid(),
  workspaceId: WorkspaceIdSchema,
});
export type PasswordsBrokerSignInRequestV6Params = z.infer<
  typeof PasswordsBrokerSignInRequestV6ParamsSchema
>;

/** The authorized login's public descriptor. No field value is released. */
export const PasswordsBrokerLoginSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  account: z.string().max(200),
  hasTOTP: z.boolean(),
});
export type PasswordsBrokerLogin = z.infer<typeof PasswordsBrokerLoginSchema>;

export {
  PasswordsBrokerAccountSchema,
  PasswordsBrokerAccountsSchema,
  type PasswordsBrokerAccount,
} from "./password-sign-in-accounts.js";
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
 * Only this time. The broker prepares the exact login revision and consent;
 * only signin.commit after durable Host acceptance enables release and grants.
 */
export const PasswordsBrokerSignInApproveParamsSchema = z.strictObject({
  permissionVersion: z.literal(5),
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
export const PasswordsBrokerSignInReleaseV6ParamsSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    transactionId: z.uuid(),
    field: PasswordsBrokerSignInReleaseParamsSchema.shape.field,
    kind: z.literal("app"),
  }),
  PasswordsBrokerSignInReleaseParamsSchema.extend({ kind: z.literal("browser") }),
]);
export type PasswordsBrokerSignInReleaseV6Params = z.infer<
  typeof PasswordsBrokerSignInReleaseV6ParamsSchema
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

export const PasswordsBrokerCardRequestParamsSchema = z.strictObject({
  ...PasswordsBrokerSignInRequestV6ParamsSchema.shape,
  protocolVersion: z.literal(7),
  permissionVersion: z.literal(7),
});
export const PasswordsBrokerCardApproveParamsSchema = z.strictObject({
  transactionId: z.uuid(),
  ...CardApprovalSchema.shape,
});
export const PasswordsBrokerCardReleaseParamsSchema = z.strictObject({
  transactionId: z.uuid(),
  topOrigin: PasswordsOriginSchema,
  frameOrigin: PasswordsOriginSchema,
  field: CardFieldSchema,
});
export const PasswordsBrokerCardRequestResultSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("approve"), cards: CardChoicesSchema }),
  z.strictObject({
    decision: z.literal("unavailable"),
    reason: PasswordsBrokerUnavailableReasonSchema,
  }),
]);
export const PasswordsBrokerCardApproveResultSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("authorized"),
    card: z.strictObject({
      id: z.uuid(),
      revision: CardApprovalSchema.shape.revision,
      ...CardPublicSchema.shape,
    }),
  }),
  z.strictObject({
    decision: z.literal("approve"),
    cards: CardChoicesSchema,
    message: z.string().min(1).max(200),
  }),
  z.strictObject({
    decision: z.literal("unavailable"),
    reason: PasswordsBrokerUnavailableReasonSchema.exclude(["busy"]),
  }),
]);
export const PasswordsBrokerCardReleaseResultSchema = z.discriminatedUnion("released", [
  z.strictObject({ released: z.literal(true), value: z.string().max(4096) }),
  z.strictObject({
    released: z.literal(false),
    reason: z.enum(["ended", "revoked", "wrong-site", "passwords-off", "no-field"]),
  }),
]);

/** A saved login a person may fill on a site, as the broker lists it: never its password. */
export const PasswordsBrokerFillAccountSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  username: z.string().max(1_024),
  label: z.string().min(1).max(200).nullable(),
  hasCode: z.boolean(),
});
export type PasswordsBrokerFillAccount = z.infer<typeof PasswordsBrokerFillAccountSchema>;

/** The logins whose saved websites are within `origin`'s site. Never prompts. */
export const PasswordsBrokerFillAccountsParamsSchema = z.strictObject({
  origin: PasswordsOriginSchema,
});
/** `accounts` is empty unless `fill` is `on`. */
export const PasswordsBrokerFillAccountsResultSchema = z.strictObject({
  fill: z.enum(["on", "off", "not-set-up"]),
  accounts: z.array(PasswordsBrokerFillAccountSchema).max(100),
});

/**
 * Opens a person transaction pinned to the login, its revision and
 * `origin`'s site. With `here` the broker asks Touch ID or the Mac password
 * itself first; `elsewhere` never prompts. Fields are released with
 * `signin.release` (kind browser) and the transaction ends with
 * `signin.cancel` or at `expiresAt`.
 */
export const PasswordsBrokerFillBeginParamsSchema = z.strictObject({
  transactionId: z.uuid(),
  loginId: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  origin: PasswordsOriginSchema,
  presence: PersonFillPresenceSchema,
});
export const PasswordsBrokerFillBeginResultSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("authorized"),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  /** The login is gone, changed revision, or is not saved for this site. */
  z.strictObject({ decision: z.literal("changed") }),
  /** The person cancelled or failed the check, or it was withdrawn. */
  z.strictObject({ decision: z.literal("cancelled") }),
  z.strictObject({
    decision: z.literal("unavailable"),
    reason: z.enum(["fill-off", "not-set-up", "busy"]),
  }),
]);

/** Each method's parameters, as Electron main sends them. */
export const passwordsBrokerRequests = {
  "card.probe": PasswordsBrokerEmptySchema,
  "card.request": PasswordsBrokerCardRequestParamsSchema,
  "card.approve": PasswordsBrokerCardApproveParamsSchema,
  "card.release": PasswordsBrokerCardReleaseParamsSchema,
  "fill.accounts": PasswordsBrokerFillAccountsParamsSchema,
  "fill.begin": PasswordsBrokerFillBeginParamsSchema,
  hello: PasswordsBrokerHelloParamsSchema,
  "signin.approve": PasswordsBrokerSignInApproveParamsSchema,
  "signin.commit": PasswordsBrokerTransactionParamsSchema,
  "signin.cancel": PasswordsBrokerTransactionParamsSchema,
  "signin.probe": PasswordsBrokerSignInProbeParamsSchema,
  "signin.request": z.union([
    PasswordsBrokerSignInRequestParamsSchema,
    PasswordsBrokerSignInRequestV6ParamsSchema,
  ]),
  "signin.release": z.union([
    PasswordsBrokerSignInReleaseParamsSchema,
    PasswordsBrokerSignInReleaseV6ParamsSchema,
  ]),
  status: PasswordsBrokerEmptySchema,
  "window.open": PasswordsBrokerEmptySchema,
} as const satisfies Record<PasswordsBrokerMethod, z.ZodType>;

/** Each method's result, as the broker answers it. */
export const passwordsBrokerResults = {
  "card.probe": z.strictObject({ cards: CardAvailabilitySchema }),
  "card.request": PasswordsBrokerCardRequestResultSchema,
  "card.approve": PasswordsBrokerCardApproveResultSchema,
  "card.release": PasswordsBrokerCardReleaseResultSchema,
  "fill.accounts": PasswordsBrokerFillAccountsResultSchema,
  "fill.begin": PasswordsBrokerFillBeginResultSchema,
  hello: PasswordsBrokerHelloResultSchema,
  "signin.approve": PasswordsBrokerSignInApproveResultSchema,
  "signin.commit": z.strictObject({ committed: z.boolean() }),
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
