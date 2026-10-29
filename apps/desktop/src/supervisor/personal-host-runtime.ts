import { IsoDateTimeSchema } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  HostDiscoveryDocumentSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteEnvelopeSchema,
  sameDiscoveryDocument,
  isSameHost,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { ConnectLocalOriginSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";

/**
 * Evidence supplied only by the Desktop-owned Personal Host supervisor after
 * it starts that exact Host and verifies its signed discovery document over
 * the loopback endpoint. A catalog entry cannot create this record.
 */
export const PersonalHostRuntimeRecordSchema = z
  .strictObject({
    discovery: HostDiscoveryDocumentSchema,
    discoveryEnvelope: HostDiscoveryEnvelopeSchema,
    localOrigin: ConnectLocalOriginSchema,
    observedAt: IsoDateTimeSchema,
    ownership: z.literal("desktop-personal-host-supervisor"),
    schemaVersion: z.literal(2),
    state: z.literal("ready"),
    verification: z.literal("signed-loopback-discovery"),
  })
  .superRefine((record, context) => {
    if (!sameDiscoveryDocument(record.discovery, record.discoveryEnvelope.document)) {
      context.addIssue({
        code: "custom",
        message: "Personal runtime discovery must match its signed envelope",
        path: ["discoveryEnvelope"],
      });
    }
    if (!PersonalHostAccessAuthoritySchema.safeParse(record.discovery).success) {
      context.addIssue({
        code: "custom",
        message: "A Personal runtime must retain its explicit loopback canonical authority",
        path: ["discovery"],
      });
    }
  });
export type PersonalHostRuntimeRecord = z.infer<typeof PersonalHostRuntimeRecordSchema>;

export interface PersonalHostRuntimeSource {
  current(): Promise<PersonalHostRuntimeRecord | null>;
}

export const PersonalHostConnectProjectionStateSchema = z.enum(["disabled", "offline", "ready"]);

export const PersonalHostConnectProjectionSchema = z
  .strictObject({
    accessRoute: PersonalHostAccessRouteEnvelopeSchema.nullable(),
    authority: PersonalHostRuntimeRecordSchema,
    state: PersonalHostConnectProjectionStateSchema,
  })
  .superRefine((projection, context) => {
    if ((projection.state === "disabled") !== (projection.accessRoute === null)) {
      context.addIssue({
        code: "custom",
        message: "Only an enabled Connect projection carries a signed access route",
        path: ["accessRoute"],
      });
    }
  });
export type PersonalHostConnectProjection = z.infer<typeof PersonalHostConnectProjectionSchema>;

/**
 * Implemented by the owning Host runtime, not by Desktop's Account client.
 * The implementation durably advances the Host projection generation and
 * publishes through its Host credential before this promise resolves.
 */
export interface PersonalHostConnectProjectionSink {
  publish(projection: PersonalHostConnectProjection): Promise<void>;
}

export interface PersonalHostConnectRouteSource {
  configureConnect(routeOrigin: string): Promise<PersonalHostConnectProjection["accessRoute"]>;
  disableConnect(): Promise<void>;
}

export function assertSamePersonalHostAuthority(
  expected: PersonalHostRuntimeRecord,
  actual: PersonalHostRuntimeRecord,
): void {
  const left = PersonalHostRuntimeRecordSchema.parse(expected);
  const right = PersonalHostRuntimeRecordSchema.parse(actual);
  if (
    left.localOrigin !== right.localOrigin ||
    !isSameHost(left.discoveryEnvelope, right.discoveryEnvelope) ||
    !sameDiscoveryDocument(left.discovery, right.discovery)
  ) {
    throw new Error("Personal Host runtime authority changed.");
  }
  // Equivalent discovery formats may have different signed bytes after an upgrade.
  if (JSON.stringify(left.discoveryEnvelope) !== JSON.stringify(right.discoveryEnvelope)) {
    verifyHostDiscoveryEnvelope(left.discoveryEnvelope);
    verifyHostDiscoveryEnvelope(right.discoveryEnvelope);
  }
}
