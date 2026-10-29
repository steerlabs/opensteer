import { DeploymentIdSchema, IsoDateTimeSchema } from "@opensteer/core";
import {
  AccountLinkGenerationSchema,
  HostAccountIdentitySchema,
  PersonalAccessRouteGenerationSchema,
  PersonalAccessRouteKindSchema,
  PersonalAccessRouteOriginSchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  personalHostAccessRouteSigningBytes,
  type PersonalAccessRouteGeneration,
  type PersonalAccessRouteKind,
  type PersonalHostAccessRouteDocument,
  type PersonalHostAccessRouteEnvelope,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  PersonalHostAccountLinkCompletionGrantSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

export {
  PersonalAccessRouteGenerationSchema,
  PersonalAccessRouteKindSchema,
  PersonalAccessRouteOriginSchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  personalHostAccessRouteSigningBytes,
};
export type {
  PersonalAccessRouteGeneration,
  PersonalAccessRouteKind,
  PersonalHostAccessRouteDocument,
  PersonalHostAccessRouteEnvelope,
};

export const PersonalRemoteAccessModeSchema = z.enum(["off", "connect", "private"]);
export type PersonalRemoteAccessMode = z.infer<typeof PersonalRemoteAccessModeSchema>;

export const ConfigurePersonalRemoteAccessRequestSchema = z
  .strictObject({
    mode: PersonalRemoteAccessModeSchema,
    routeOrigin: PersonalAccessRouteOriginSchema.nullable(),
    schemaVersion: z.literal(1),
  })
  .superRefine((request, context) => {
    if ((request.mode === "off") !== (request.routeOrigin === null)) {
      context.addIssue({
        code: "custom",
        message: request.mode === "off" ? "Off cannot retain a route" : "A route is required",
        path: ["routeOrigin"],
      });
    }
  });
export type ConfigurePersonalRemoteAccessRequest = z.infer<
  typeof ConfigurePersonalRemoteAccessRequestSchema
>;

export const PersonalRemoteAccountLinkStateSchema = z.enum(["activating", "active"]);
type PersonalRemoteAccountLinkState = z.infer<typeof PersonalRemoteAccountLinkStateSchema>;

export const PersonalRemoteAccountLinkSchema = HostAccountIdentitySchema.extend({
  generation: AccountLinkGenerationSchema,
  state: PersonalRemoteAccountLinkStateSchema,
});
export type PersonalRemoteAccountLink = z.infer<typeof PersonalRemoteAccountLinkSchema>;

/**
 * What a session that reached this Host through a signed access route is
 * allowed to learn about the Account link. Whether Connect is usable is a
 * property of this Deployment; which Account owns it is the owner's, and a
 * pairing-code guest is not the owner.
 */
export const RemotePersonalRemoteAccountLinkSchema = z.strictObject({
  state: PersonalRemoteAccountLinkStateSchema,
});

export const ResumePersonalHostAccountLinkRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
});

const personalRemoteAccessStatusFields = {
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: PersonalRemoteAccessModeSchema,
  route: PersonalHostAccessRouteEnvelopeSchema.nullable(),
  schemaVersion: z.literal(2),
} as const;

const refinePersonalRemoteAccessStatus = (
  status: {
    readonly accountLink: { readonly state: PersonalRemoteAccountLinkState } | null;
    readonly generation: number;
    readonly mode: PersonalRemoteAccessMode;
    readonly route: PersonalHostAccessRouteEnvelope | null;
  },
  context: z.RefinementCtx,
): void => {
  if ((status.mode === "off") !== (status.route === null)) {
    context.addIssue({
      code: "custom",
      message: status.mode === "off" ? "Off cannot expose a route" : "Active mode needs a route",
      path: ["route"],
    });
  }
  if (status.route) {
    if (status.route.document.route.generation !== status.generation) {
      context.addIssue({
        code: "custom",
        message: "Remote-access status and signed route generations must match",
        path: ["generation"],
      });
    }
    if (status.route.document.route.kind !== status.mode) {
      context.addIssue({
        code: "custom",
        message: "Remote-access status and signed route modes must match",
        path: ["mode"],
      });
    }
  }
  // An absent link fails this check too, so Connect never reaches a state
  // where no Account has authorized it.
  if (status.mode === "connect" && status.accountLink?.state !== "active") {
    context.addIssue({
      code: "custom",
      message: "Connect requires an active Opensteer Account link",
      path: ["accountLink"],
    });
  }
};

/** The owner's view, answered only to a machine-local session. */
export const PersonalRemoteAccessStatusSchema = z
  .strictObject({
    accountLink: PersonalRemoteAccountLinkSchema.nullable(),
    ...personalRemoteAccessStatusFields,
  })
  .superRefine(refinePersonalRemoteAccessStatus);
export type PersonalRemoteAccessStatus = z.infer<typeof PersonalRemoteAccessStatusSchema>;

/** The same status without the Account identity, for a remote session. */
export const RemotePersonalRemoteAccessStatusSchema = z
  .strictObject({
    accountLink: RemotePersonalRemoteAccountLinkSchema.nullable(),
    ...personalRemoteAccessStatusFields,
  })
  .superRefine(refinePersonalRemoteAccessStatus);
export type RemotePersonalRemoteAccessStatus = z.infer<
  typeof RemotePersonalRemoteAccessStatusSchema
>;

export const PersonalPairingCodeSchema = z
  .string()
  .regex(/^osp_[A-Za-z0-9_-]{43}$/u)
  .brand<"PersonalPairingCode">();
export const IssuePersonalPairingCodeResponseSchema = z.strictObject({
  code: PersonalPairingCodeSchema,
  expiresAt: IsoDateTimeSchema,
  generation: PersonalAccessRouteGenerationSchema,
  schemaVersion: z.literal(1),
});
export type IssuePersonalPairingCodeResponse = z.infer<
  typeof IssuePersonalPairingCodeResponseSchema
>;

export const DesktopPersonalRemoteAccessPhaseSchema = z.enum([
  "unavailable",
  "off",
  "linking-account",
  "provisioning",
  "ready",
  "offline",
  "revoking",
  "error",
]);
export type DesktopPersonalRemoteAccessPhase = z.infer<
  typeof DesktopPersonalRemoteAccessPhaseSchema
>;

export const DesktopPersonalRemoteAccessStatusSchema = z.strictObject({
  deploymentId: DeploymentIdSchema.nullable(),
  detail: z.string().trim().min(1).max(1_000).nullable(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: PersonalRemoteAccessModeSchema,
  phase: DesktopPersonalRemoteAccessPhaseSchema,
  retryable: z.boolean(),
  routeOrigin: PersonalAccessRouteOriginSchema.nullable(),
  schemaVersion: z.literal(1),
});
export type DesktopPersonalRemoteAccessStatus = z.infer<
  typeof DesktopPersonalRemoteAccessStatusSchema
>;

export const DesktopConfigurePersonalRemoteAccessInputSchema = z
  .strictObject({
    mode: PersonalRemoteAccessModeSchema,
    privateOrigin: PersonalAccessRouteOriginSchema.nullable(),
  })
  .superRefine((input, context) => {
    if ((input.mode === "private") !== (input.privateOrigin !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only Private network mode accepts a private HTTPS origin",
        path: ["privateOrigin"],
      });
    }
  });
export type DesktopConfigurePersonalRemoteAccessInput = z.infer<
  typeof DesktopConfigurePersonalRemoteAccessInputSchema
>;

export const DesktopPersonalPairingCodeSchema = IssuePersonalPairingCodeResponseSchema.extend({
  routeOrigin: PersonalAccessRouteOriginSchema,
});
export type DesktopPersonalPairingCode = z.infer<typeof DesktopPersonalPairingCodeSchema>;

export const ApprovePersonalHostAccountLinkRequestSchema =
  IssuePersonalHostAccountLinkChallengeResponseSchema;

export const ApprovePersonalHostAccountLinkResponseSchema =
  PersonalHostAccountLinkProofEnvelopeSchema;

export const ConsumePersonalHostAccountLinkRequestSchema = z.strictObject({
  completionGrant: PersonalHostAccountLinkCompletionGrantSchema,
  hostCredential: z.string().regex(/^osc_[A-Za-z0-9_-]{43}$/u),
  linkGeneration: AccountLinkGenerationSchema,
  schemaVersion: z.literal(1),
});

/**
 * Machine-readable outcomes the Personal Host reports for an Account-link
 * mutation. Desktop recovery differs per reason — a stale completion grant can
 * be refreshed from the Account, while an expired or cancelled central
 * reservation cannot — so the wire carries the reason instead of prose the
 * caller would have to match.
 */
export const PersonalHostAccountLinkErrorReasonSchema = z.enum([
  "personal-account-link-cancelled",
  "personal-account-link-grant-expired",
  "personal-account-link-reservation-expired",
]);

export const PersonalHostAccountLinkErrorResponseSchema = z.object({
  error: z.object({ reason: PersonalHostAccountLinkErrorReasonSchema }),
});

export const PersonalHostAccountUnlinkStepRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
});

export const PublishPersonalConnectProjectionRequestSchema = z
  .strictObject({
    expectedAccessRoute: PersonalHostAccessRouteEnvelopeSchema.nullable(),
    schemaVersion: z.literal(2),
    state: z.enum(["disabled", "offline", "ready"]),
  })
  .superRefine((request, context) => {
    if ((request.state === "disabled") !== (request.expectedAccessRoute === null)) {
      context.addIssue({
        code: "custom",
        message: "Only an enabled Connect projection carries its expected signed route",
        path: ["expectedAccessRoute"],
      });
    }
  });
export type PublishPersonalConnectProjectionRequest = z.infer<
  typeof PublishPersonalConnectProjectionRequestSchema
>;
