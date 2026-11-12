import { z } from "zod";
import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  DeploymentKindSchema,
  DeploymentShapeSchema,
  HostInstanceIdSchema,
} from "./primitives.js";

export const HostDiscoveryDeploymentSchema = DeploymentShapeSchema;
export type HostDiscoveryDeployment = z.infer<typeof HostDiscoveryDeploymentSchema>;

export const HostDiscoveryDocumentSchema = z.strictObject({
  canonicalOrigin: CanonicalOriginSchema,
  deploymentId: DeploymentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  hostKey: z.strictObject({
    algorithm: z.literal("Ed25519"),
  }),
  deploymentShape: HostDiscoveryDeploymentSchema,
});
export type HostDiscoveryDocument = z.infer<typeof HostDiscoveryDocumentSchema>;

export const HostDiscoveryEnvelopeSchema = z.strictObject({
  document: HostDiscoveryDocumentSchema,
  publicKey: z.strictObject({
    algorithm: z.literal("Ed25519"),
    spki: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/u),
  }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type HostDiscoveryEnvelope = z.infer<typeof HostDiscoveryEnvelopeSchema>;

export const HostBootstrapMethodSchema = z.enum([
  "pairing-code",
  "connect-grant",
  "password",
  "oidc",
]);
export type HostBootstrapMethod = z.infer<typeof HostBootstrapMethodSchema>;

/** `/.well-known/opensteer`. The outer object is tolerant; the signed `authority` is exact. */
export const HostDescriptorSchema = z.object({
  kind: DeploymentKindSchema,
  apiVersion: z.number().int().positive(),
  minimumApiVersion: z.number().int().positive().optional(),
  authority: HostDiscoveryEnvelopeSchema,
  bootstrapMethods: z.array(HostBootstrapMethodSchema).max(4),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
});
export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

/** Exact bytes signed by a Host for public route discovery. */
export function hostDiscoverySigningBytes(document: HostDiscoveryDocument): Uint8Array {
  const value = HostDiscoveryDocumentSchema.parse(document);
  return new TextEncoder().encode(
    `opensteer-host-discovery-v4\0${JSON.stringify({
      canonicalOrigin: value.canonicalOrigin,
      deploymentId: value.deploymentId,
      hostInstanceId: value.hostInstanceId,
      hostKey: {
        algorithm: value.hostKey.algorithm,
      },
      deploymentShape: value.deploymentShape,
    })}`,
  );
}
