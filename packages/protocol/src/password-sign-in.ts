import {
  BrowserSiteSchema,
  RequestIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  DeploymentIdSchema,
} from "@opensteer/core";
import { z } from "zod";
import {
  PasswordsBrokerAccountsSchema,
  PasswordsBrokerAccountSchema,
} from "./password-sign-in-accounts.js";
import {
  CardChooserSchema,
  CardChooserViewSchema,
  CardApprovalSchema,
  CardRefSchema,
  CardAvailabilitySchema,
  CardAuthorizationOutcomeSchema,
} from "./card-use.js";
import { ComputerUseSessionIdSchema } from "./computer-use-id.js";

/** One deadline covers approval and the authorized login lease. */
export const passwordLoginLifetimeMs = 60 * 60_000;
/** How long the Host waits for a runtime to say whether Passwords is on. */
export const passwordSignInProbeTimeoutMs = 5_000;
/** Concurrent pending login authorizations one browser host accepts. */
export const maxPasswordSignInsPerHost = 4;
/**
 * The longest one `sign_in` call waits for its operation before it
 * answers with what is known, kept under the engines' 60-second tool limit.
 */
export const passwordSignInAgentWaitMs = 45_000;

/**
 * What the Mac says about signing in to one site, without asking the person.
 * `has-login`: a saved login covers the site. `no-login`: Passwords is ready
 * but has none for it. `off`: the person turned agent sign-ins off.
 * `unavailable`: Passwords could not answer right now.
 */
export const PasswordSignInAvailabilitySchema = z.enum([
  "has-login",
  "no-login",
  "off",
  "not-set-up",
  "unavailable",
]);
export type PasswordSignInAvailability = z.infer<typeof PasswordSignInAvailabilitySchema>;

/**
 * Display text for the approval. It is chosen by the Host and the agent, so the
 * Mac shows it as context, never as proof of who is asking.
 */
export const PasswordSignInRequesterSchema = z.strictObject({
  deploymentId: z.string().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
  threadTitle: z.string().trim().min(1).max(200),
  deploymentName: z.string().trim().min(1).max(120),
});
export type PasswordSignInRequester = z.infer<typeof PasswordSignInRequesterSchema>;

export const PasswordSignInCancelReasonSchema = z.enum([
  "declined",
  "withdrawn",
  "expired",
  "authority-lost",
]);
export type PasswordSignInCancelReason = z.infer<typeof PasswordSignInCancelReasonSchema>;

/**
 * Why a Mac could not take a sign-in it had reported ready for: the person
 * turned agent sign-ins off or reset Passwords in between, or Opensteer
 * Passwords stopped answering before anyone decided.
 */
export const PasswordSignInUnavailableReasonSchema = z.enum([
  "passwords-off",
  "not-set-up",
  "not-responding",
  "no-saved-login",
]);
export type PasswordSignInUnavailableReason = z.infer<typeof PasswordSignInUnavailableReasonSchema>;

export const LoginRefSchema = z
  .string()
  .regex(
    /^lgn_[0-9a-f]{32}$/u,
    "Saved card references can only be used with fillCard in a Browser Session.",
  );
/** Why `use_saved_login` has no login to hand over. */
export const SavedLoginUnavailableReasonSchema = z.enum([
  "no-saved-login",
  "passwords-off",
  "passwords-not-set-up",
  "passwords-not-responding",
  /** Saved logins fill websites only in the hosting computer's own browser. */
  "main-browser-required",
  "unsupported",
  "runtime-outdated",
  "session-closed",
  /** A loopback site or this Deployment's own site. */
  "not-allowed",
  "rate-limited",
  /** Another Deployment's sign-in to this site is waiting on the person. */
  "busy",
  /** This Run can no longer open Requests. */
  "stopped",
  "needs-approval",
  "expired",
  "interrupted",
]);
export type SavedLoginUnavailableReason = z.infer<typeof SavedLoginUnavailableReasonSchema>;

/** What an agent learns from `use_saved_login`; it never carries a saved value. */
export const SavedLoginResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    site: BrowserSiteSchema,
    loginRef: LoginRefSchema,
    /** Masked; names which saved account the reference fills. */
    account: z.string().max(200),
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
    reason: SavedLoginUnavailableReasonSchema,
  }),
]);
export type SavedLoginResult = z.infer<typeof SavedLoginResultSchema>;

/** What Opensteer Passwords lacks that the person can fix: a login, setup, or turning it on. */
export const PasswordsNeedSchema = z.enum(["no-login", "not-set-up", "off"]);
export type PasswordsNeed = z.infer<typeof PasswordsNeedSchema>;

/** What the person could fix in Passwords for this result, or null when nothing would help. */
export function savedLoginPasswordsNeed(result: SavedLoginResult): PasswordsNeed | null {
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

export const LoginFieldSchema = z.enum(["username", "password", "code"]);
export type LoginField = z.infer<typeof LoginFieldSchema>;
export const LoginFillStatusSchema = z.enum([
  "filled",
  "no-field",
  "wrong-site",
  "stale",
  "expired",
  "denied",
  "unavailable",
]);
export type LoginFillStatus = z.infer<typeof LoginFillStatusSchema>;
export const LoginAuthorizationOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("authorized"),
    loginRef: LoginRefSchema,
    account: z.string().max(200),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({ kind: z.literal("declined") }),
  z.strictObject({ kind: z.literal("cancelled"), reason: PasswordSignInCancelReasonSchema }),
  z.strictObject({ kind: z.literal("expired") }),
  z.strictObject({ kind: z.literal("unavailable"), reason: PasswordSignInUnavailableReasonSchema }),
  z.strictObject({ kind: z.literal("busy") }),
]);
export type LoginAuthorizationOutcome = z.infer<typeof LoginAuthorizationOutcomeSchema>;

/** A fulfilled `browser.password-sign-in` Request's response value. */
export const PasswordSignInRequestResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("authorized"), account: z.string().max(200) }),
  z.strictObject({ outcome: z.literal("expired") }),
  z.strictObject({
    outcome: z.literal("unavailable"),
    reason: PasswordSignInUnavailableReasonSchema,
  }),
  z.strictObject({ outcome: z.literal("session-closed") }),
  /** The sign-in stopped before any handoff, including a withdrawal or lost authority. */
  z.strictObject({ outcome: z.literal("interrupted") }),
]);
export type PasswordSignInRequestResponse = z.infer<typeof PasswordSignInRequestResponseSchema>;

/** A reference is agent input; only the vault authority resolves its value. */
export const LoginTextSchema = z.strictObject({
  loginRef: LoginRefSchema,
  field: LoginFieldSchema,
});
export type LoginText = z.infer<typeof LoginTextSchema>;

export const loginEnvelopeMaxLifetimeMs = 60_000;
export const loginEnvelopeHkdfInfo = "opensteer/login-text/v1";
export const loginEnvelopeMaxValueLength = 4_096;
export const loginEnvelopeMaxPlaintextBytes = 16_384;

const loginConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const loginConnectionGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const loginActIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
// Structural bounds here; crypto consumers also reject noncanonical encodings
// and invalid curve points before deriving a key.
const loginPublicKeySchema = z.base64url().length(87).startsWith("B");

/** Public key of the final executor, announced on its authenticated live connection. */
export const LoginReceiverKeySchema = z.strictObject({
  version: z.literal(1),
  connectionId: loginConnectionIdSchema,
  connectionGeneration: loginConnectionGenerationSchema,
  publicKey: loginPublicKeySchema,
});
export type LoginReceiverKey = z.infer<typeof LoginReceiverKeySchema>;

/** Canonical compact JSON of this flat object, encoded as UTF-8, is the GCM AAD. */
export const LoginEnvelopeBindingSchema = z.strictObject({
  version: z.literal(1),
  connectionId: loginConnectionIdSchema,
  connectionGeneration: loginConnectionGenerationSchema,
  runId: RunIdSchema,
  sessionId: ComputerUseSessionIdSchema,
  actId: loginActIdSchema,
  actionIndex: z.number().int().min(0).max(31),
  field: LoginFieldSchema,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type LoginEnvelopeBinding = z.infer<typeof LoginEnvelopeBindingSchema>;

/** P-256 ECDH -> HKDF-SHA256 -> AES-256-GCM; all binary fields are unpadded base64url. */
export const SealedLoginEnvelopeSchema = z.strictObject({
  binding: LoginEnvelopeBindingSchema,
  senderPublicKey: loginPublicKeySchema,
  salt: z.base64url().length(43),
  nonce: z.base64url().length(16),
  ciphertext: z.base64url().max(Math.ceil((loginEnvelopeMaxPlaintextBytes * 4) / 3)),
  tag: z.base64url().length(22),
});
export type SealedLoginEnvelope = z.infer<typeof SealedLoginEnvelopeSchema>;

/** Dispatch-only text: never accepted from an agent. */
export const SealedLoginTextSchema = z.strictObject({ sealed: SealedLoginEnvelopeSchema });
export type SealedLoginText = z.infer<typeof SealedLoginTextSchema>;
export const LoginActContextSchema = z.strictObject({
  runId: RunIdSchema,
  actId: loginActIdSchema,
});
export type LoginActContext = z.infer<typeof LoginActContextSchema>;

/** The Mac's internal act needs the Run/act identity the outer phone frame already carries. */
export function validateSealedLoginActionBindings(
  params: {
    readonly actions: readonly {
      readonly type: string;
      readonly text?: string | SealedLoginText;
    }[];
    readonly loginContext?: LoginActContext | undefined;
    readonly sessionId?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  for (const [index, action] of params.actions.entries()) {
    if (action.type !== "type" || typeof action.text !== "object") continue;
    const binding = action.text.sealed.binding;
    if (
      !params.loginContext ||
      binding.runId !== params.loginContext.runId ||
      binding.actId !== params.loginContext.actId ||
      binding.actionIndex !== index ||
      (params.sessionId !== undefined && binding.sessionId !== params.sessionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Saved login text must match this batch's Run, session, act and action",
        path: ["actions", index, "text"],
      });
    }
  }
}

/** Person-only, transient chooser metadata. Never include it in Request events. */
export const PasswordSignInCardSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    stage: z.literal("approval"),
    accounts: PasswordsBrokerAccountsSchema,
    permissionVersion: z.literal(6),
  }),
  z.strictObject({ stage: z.literal("authorized") }),
  z.strictObject({ stage: z.literal("gone") }),
  CardChooserSchema,
]);
export type PasswordSignInCard = z.infer<typeof PasswordSignInCardSchema>;
export const PasswordSignInCardViewSchema = z.discriminatedUnion("stage", [
  z.object({
    ...PasswordSignInCardSchema.options[0].shape,
    accounts: z.array(z.object(PasswordsBrokerAccountSchema.shape)).max(100),
  }),
  z.object(PasswordSignInCardSchema.options[1].shape),
  z.object(PasswordSignInCardSchema.options[2].shape),
  CardChooserViewSchema,
]);

export const PasswordSignInApprovalSchema = z.strictObject({
  loginId: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  remember: z.boolean(),
  permissionVersion: z.literal(6),
});
/** Session-independent Host commands, carried by the Personal Runner/desktop bridge. */
export const PasswordSignInAuthorityCommandSchema = z.union([
  z.strictObject({ type: z.literal("card.probe") }),
  z.strictObject({
    type: z.literal("login.authorize"),
    credential: z.literal("card"),
    operationId: z.uuid(),
    cardRef: CardRefSchema,
    site: BrowserSiteSchema,
    deploymentId: DeploymentIdSchema,
    requester: PasswordSignInRequesterSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    type: z.literal("login.approve"),
    credential: z.literal("card"),
    operationId: z.uuid(),
    ...CardApprovalSchema.shape,
  }),
  z.strictObject({ type: z.literal("signin.probe"), site: BrowserSiteSchema }),
  z.strictObject({ type: z.literal("login.get"), operationId: z.uuid() }),
  z.strictObject({
    type: z.literal("login.approve"),
    operationId: z.uuid(),
    ...PasswordSignInApprovalSchema.shape,
  }),
  z.strictObject({ type: z.literal("login.commit"), operationId: z.uuid() }),
  z.strictObject({
    type: z.literal("login.authorize"),
    operationId: z.uuid(),
    loginRef: LoginRefSchema,
    site: BrowserSiteSchema,
    deploymentId: DeploymentIdSchema,
    requester: PasswordSignInRequesterSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    type: z.literal("login.seal"),
    operationId: z.uuid(),
    receiver: LoginReceiverKeySchema,
    binding: LoginEnvelopeBindingSchema,
  }),
  z.strictObject({
    type: z.literal("login.cancel"),
    operationId: z.uuid(),
    reason: PasswordSignInCancelReasonSchema,
  }),
]);
export type PasswordSignInAuthorityCommand = z.infer<typeof PasswordSignInAuthorityCommandSchema>;

export const LoginSealResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    type: z.literal("login.seal.result"),
    status: z.literal("sealed"),
    envelope: SealedLoginEnvelopeSchema,
  }),
  z.strictObject({
    type: z.literal("login.seal.result"),
    status: z.enum(["expired", "denied", "unavailable"]),
  }),
]);
export type LoginSealResult = z.infer<typeof LoginSealResultSchema>;
export const PasswordSignInAuthorityResultSchema = z.union([
  z.strictObject({ type: z.literal("card.probe.result"), cards: CardAvailabilitySchema }),
  z.strictObject({
    type: z.literal("signin.probe.result"),
    passwords: PasswordSignInAvailabilitySchema,
  }),
  z.strictObject({ type: z.literal("login.get.result"), card: PasswordSignInCardSchema }),
  z.strictObject({
    type: z.literal("login.approve.result"),
    result: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({
        ok: z.literal(false),
        message: z.string().min(1).max(200),
        card: PasswordSignInCardSchema,
      }),
    ]),
  }),
  z.strictObject({ type: z.literal("login.committed"), committed: z.boolean() }),
  z.strictObject({ type: z.literal("login.authorize.started") }),
  z.strictObject({ type: z.literal("login.cancelled") }),
  LoginSealResultSchema,
  z.strictObject({ type: z.literal("unavailable") }),
]);
export type PasswordSignInAuthorityResult = z.infer<typeof PasswordSignInAuthorityResultSchema>;
export const PasswordSignInAuthorityEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("login.needs"),
    operationId: z.uuid(),
    need: z.literal("approval").nullable(),
  }),
  z.strictObject({
    type: z.literal("login.result"),
    operationId: z.uuid(),
    outcome: z.union([LoginAuthorizationOutcomeSchema, CardAuthorizationOutcomeSchema]),
  }),
  z.strictObject({ type: z.literal("login.ended"), operationId: z.uuid() }),
]);
export type PasswordSignInAuthorityEvent = z.infer<typeof PasswordSignInAuthorityEventSchema>;

export const SessionlessPasswordSignInRequestPayloadSchema = z.strictObject({
  kind: z.literal("browser.password-sign-in"),
  scope: z.literal("personal"),
  // Older readers require 5; credential names the consent.
  permissionVersion: z.literal(6),
  credential: z.literal("card").optional(),
  computerName: z.string().trim().min(1).max(160),
  expiresAt: z.iso.datetime({ offset: true }),
  operationId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  runnerId: RunnerIdSchema,
  site: BrowserSiteSchema,
});
export type SessionlessPasswordSignInRequestPayload = z.infer<
  typeof SessionlessPasswordSignInRequestPayloadSchema
>;
