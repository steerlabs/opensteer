import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
} from "@opensteer/core";
import { PersonalAccessRouteOriginSchema } from "@opensteer/deployment-authority/personal-access-route";
import { z } from "zod";

export {
  PersonalAccessRouteGenerationSchema,
  PersonalAccessRouteKindSchema,
  PersonalAccessRouteOriginSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  maximumPersonalHostAccessRouteSigningBytes,
  personalHostAccessRouteEnvelopeSha256,
  personalHostAccessRouteSigningBytes,
} from "@opensteer/deployment-authority/personal-access-route";
export type {
  PersonalAccessRouteGeneration,
  PersonalAccessRouteKind,
  PersonalAccessRouteOrigin,
  PersonalHostAccessAuthority,
  PersonalHostAccessRouteDocument,
  PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority/personal-access-route";

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const ConnectOperationIdSchema = z
  .string()
  .regex(new RegExp(`^cop_${uuidPattern}$`, "i"))
  .brand<"ConnectOperationId">();
export type ConnectOperationId = z.infer<typeof ConnectOperationIdSchema>;

export const ConnectLocalOriginSchema = z
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected an HTTP loopback origin with an explicit port",
      });
    }
  })
  .transform((value) => new URL(value).origin);

const ConnectAuthorityFenceSchema = z.strictObject({
  hostInstanceId: HostInstanceIdSchema,
});

export const ProvisionConnectRequestSchema = z.strictObject({
  ...ConnectAuthorityFenceSchema.shape,
  localOrigin: ConnectLocalOriginSchema,
  operationId: ConnectOperationIdSchema,
});
export type ProvisionConnectRequest = z.infer<typeof ProvisionConnectRequestSchema>;

export const RotateConnectCredentialRequestSchema = z.strictObject({
  ...ConnectAuthorityFenceSchema.shape,
  operationId: ConnectOperationIdSchema,
});
export type RotateConnectCredentialRequest = z.infer<typeof RotateConnectCredentialRequestSchema>;

export const RevokeConnectRequestSchema = RotateConnectCredentialRequestSchema;
export type RevokeConnectRequest = z.infer<typeof RevokeConnectRequestSchema>;

export const ConnectCredentialResponseSchema = z.object({
  canonicalOrigin: CanonicalOriginSchema,
  deploymentId: DeploymentIdSchema,
  connectorCredentialGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostInstanceId: HostInstanceIdSchema,
  hostKeyFingerprint: HostKeyFingerprintSchema,
  routeOrigin: PersonalAccessRouteOriginSchema,
  tunnelToken: z.string().trim().min(32).max(16_384),
});
export type ConnectCredentialResponse = z.infer<typeof ConnectCredentialResponseSchema>;

export const RevokeConnectResponseSchema = z.object({
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revoked: z.literal(true),
});
export type RevokeConnectResponse = z.infer<typeof RevokeConnectResponseSchema>;
