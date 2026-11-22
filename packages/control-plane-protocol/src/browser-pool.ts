import { z } from "zod";
import { prefixedIdSchema } from "./account-id.js";
import {
  CloudComputerBootstrapTokenSchema,
  CloudComputerDesiredRevisionSchema,
  CloudComputerGenerationSchema,
  CloudComputerIdSchema,
  CloudComputerInstallerSha256Schema,
  CloudComputerInstallerUrlSchema,
  CloudComputerLocationSchema,
  GoogleComputeServerRefSchema,
} from "./cloud-computers.js";

export const defaultBrowserPoolAgentPort = 7310;
export const defaultBrowserPoolAdminPort = 7311;
export const defaultBrowserPoolRelayPort = 7312;

export const BrowserPoolHostIdSchema = prefixedIdSchema("ph")
  .refine((id) => id === id.toLowerCase())
  .brand<"BrowserPoolHostId">();
export type BrowserPoolHostId = z.infer<typeof BrowserPoolHostIdSchema>;

export const BrowserPoolSlotIdSchema = prefixedIdSchema("bps")
  .refine((id) => id === id.toLowerCase())
  .brand<"BrowserPoolSlotId">();
export type BrowserPoolSlotId = z.infer<typeof BrowserPoolSlotIdSchema>;

export const BrowserPoolTermSchema = z.number().int().positive();
export const BrowserPoolSpkiBase64Schema = z.string().regex(/^[A-Za-z0-9+/]{40,200}={0,2}$/u);
export const BrowserPoolResourceNameSchema = z
  .string()
  .regex(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u);
export const BrowserPoolDiskRefSchema = z
  .string()
  .regex(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?\/[1-9][0-9]{0,19}$/u);

export const BrowserPoolHostReleaseArtifactsSchema = z.strictObject({
  agentUrl: CloudComputerInstallerUrlSchema,
  agentSha256: CloudComputerInstallerSha256Schema,
  relayUrl: CloudComputerInstallerUrlSchema,
  relaySha256: CloudComputerInstallerSha256Schema,
  rootfsUrl: CloudComputerInstallerUrlSchema,
  rootfsSha256: CloudComputerInstallerSha256Schema,
  kernelUrl: CloudComputerInstallerUrlSchema,
  kernelSha256: CloudComputerInstallerSha256Schema,
  egressUrl: CloudComputerInstallerUrlSchema,
  egressSha256: CloudComputerInstallerSha256Schema,
});
export type BrowserPoolHostReleaseArtifacts = z.infer<typeof BrowserPoolHostReleaseArtifactsSchema>;

export const BrowserPoolHostReleaseSchema = z.strictObject({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u),
  installerUrl: CloudComputerInstallerUrlSchema,
  installerSha256: CloudComputerInstallerSha256Schema,
  artifacts: BrowserPoolHostReleaseArtifactsSchema,
});
export type BrowserPoolHostRelease = z.infer<typeof BrowserPoolHostReleaseSchema>;

export const BrowserPoolHostProviderWriteSchema = z.strictObject({
  token: z.uuid(),
  kind: z.enum(["create-disk", "create", "power-on"]),
  generation: CloudComputerGenerationSchema,
  serverRef: GoogleComputeServerRefSchema.optional(),
  diskName: BrowserPoolResourceNameSchema.optional(),
  recoverAfter: z.iso.datetime().optional(),
  dispatched: z.boolean().optional(),
});
export type BrowserPoolHostProviderWrite = z.infer<typeof BrowserPoolHostProviderWriteSchema>;

export const BrowserPoolHostStateSchema = z.enum(["active", "draining", "deleted"]);
export type BrowserPoolHostState = z.infer<typeof BrowserPoolHostStateSchema>;

export const BrowserPoolHostPhaseSchema = z.enum([
  "provisioning",
  "booting",
  "ready",
  "deleting",
  "deleted",
  "failed",
]);
export type BrowserPoolHostPhase = z.infer<typeof BrowserPoolHostPhaseSchema>;

export const BrowserPoolHostDesiredSchema = z
  .strictObject({
    id: BrowserPoolHostIdSchema,
    generation: CloudComputerGenerationSchema,
    revision: CloudComputerDesiredRevisionSchema,
    state: BrowserPoolHostStateSchema,
    region: CloudComputerLocationSchema,
    machineType: CloudComputerLocationSchema,
    slotsCapacity: z.number().int().min(1).max(16_384),
    profileDiskName: BrowserPoolResourceNameSchema,
    profileDiskSizeGb: z.number().int().min(10).max(65_536),
    profileDiskRef: BrowserPoolDiskRefSchema.optional(),
    release: BrowserPoolHostReleaseSchema,
    providerServerRef: GoogleComputeServerRefSchema.optional(),
    previousProviderServerRef: GoogleComputeServerRefSchema.optional(),
    internalIp: z.ipv4().optional(),
    enrolled: z.boolean(),
    bootstrapToken: CloudComputerBootstrapTokenSchema.optional(),
    hostKey: BrowserPoolSpkiBase64Schema.optional(),
    relayKey: BrowserPoolSpkiBase64Schema.optional(),
    pendingProviderWrites: z.array(BrowserPoolHostProviderWriteSchema).max(4).optional(),
    readinessStartedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((value) => value.state !== "deleted" || value.bootstrapToken === undefined, {
    path: ["bootstrapToken"],
    message: "A deleted pool host cannot have a bootstrap token",
  });
export type BrowserPoolHostDesired = z.infer<typeof BrowserPoolHostDesiredSchema>;

export const BrowserPoolHostDesiredPageSchema = z.object({
  after: BrowserPoolHostIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const BrowserPoolHostDesiredResponseSchema = z.strictObject({
  next: BrowserPoolHostIdSchema.optional(),
  hosts: z
    .array(BrowserPoolHostDesiredSchema)
    .max(10_000)
    .refine((hosts) => new Set(hosts.map(({ id }) => id)).size === hosts.length, {
      message: "Pool host IDs must be unique",
    }),
});
export type BrowserPoolHostDesiredResponse = z.infer<typeof BrowserPoolHostDesiredResponseSchema>;

export const BrowserPoolHostErrorSchema = z.enum([
  "A bootstrap token is required to create this pool host.",
  "The provider has a newer pool host generation.",
  "The pool host has more than one server for this generation.",
  "The pool host did not become ready before its deadline.",
  "The pool host provider operation failed.",
  "The pool host still holds active browser slots.",
]);
export type BrowserPoolHostError = z.infer<typeof BrowserPoolHostErrorSchema>;

export const BrowserPoolHostReportSchema = z
  .strictObject({
    id: BrowserPoolHostIdSchema,
    generation: CloudComputerGenerationSchema,
    revision: CloudComputerDesiredRevisionSchema,
    phase: BrowserPoolHostPhaseSchema,
    providerServerRef: GoogleComputeServerRefSchema.nullable(),
    profileDiskRef: BrowserPoolDiskRefSchema.nullable(),
    internalIp: z.ipv4().nullable(),
    lastError: BrowserPoolHostErrorSchema.nullable(),
  })
  .superRefine((report, context) => {
    if (
      report.phase === "ready" &&
      (!report.providerServerRef || !report.profileDiskRef || !report.internalIp)
    ) {
      context.addIssue({
        code: "custom",
        message: "A ready pool host requires a server ref, profile disk ref, and internal IP",
      });
    }
    if (
      report.phase === "deleted" &&
      (report.providerServerRef !== null ||
        report.profileDiskRef !== null ||
        report.internalIp !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A deleted pool host cannot retain server, disk, or IP references",
      });
    }
    if ((report.phase === "failed") !== (report.lastError !== null)) {
      context.addIssue({
        code: "custom",
        path: ["lastError"],
        message: "Only failed pool host reports carry an error",
      });
    }
  });
export type BrowserPoolHostReport = z.infer<typeof BrowserPoolHostReportSchema>;

export const BrowserPoolHostCheckSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("orphan") }),
  z.strictObject({
    operation: z.literal("begin-provider-write"),
    revision: CloudComputerDesiredRevisionSchema,
    write: BrowserPoolHostProviderWriteSchema,
  }),
  z.strictObject({ operation: z.literal("finish-provider-write"), token: z.uuid() }),
  z.strictObject({
    operation: z.enum(["recover-provider-write", "send-provider-write"]),
    revision: CloudComputerDesiredRevisionSchema,
    token: z.uuid(),
  }),
  z.strictObject({
    operation: z.enum(["mutate", "create"]),
    revision: CloudComputerDesiredRevisionSchema,
  }),
]);
export type BrowserPoolHostCheck = z.infer<typeof BrowserPoolHostCheckSchema>;

export const BrowserPoolHostBootRequestSchema = z.strictObject({
  generation: CloudComputerGenerationSchema,
  bootstrapToken: CloudComputerBootstrapTokenSchema,
});
export type BrowserPoolHostBootRequest = z.infer<typeof BrowserPoolHostBootRequestSchema>;

export const BrowserPoolHostBootResponseSchema = z.strictObject({
  hostId: BrowserPoolHostIdSchema,
  generation: CloudComputerGenerationSchema,
  profileDiskName: BrowserPoolResourceNameSchema,
  release: BrowserPoolHostReleaseSchema,
});
export type BrowserPoolHostBootResponse = z.infer<typeof BrowserPoolHostBootResponseSchema>;

export const BrowserPoolHostBootCompleteRequestSchema = BrowserPoolHostBootRequestSchema.extend({
  hostKey: BrowserPoolSpkiBase64Schema,
  relayKey: BrowserPoolSpkiBase64Schema,
});
export type BrowserPoolHostBootCompleteRequest = z.infer<
  typeof BrowserPoolHostBootCompleteRequestSchema
>;

export const BrowserPoolHostBootCompleteResponseSchema = z.strictObject({
  completed: z.literal(true),
});
export type BrowserPoolHostBootCompleteResponse = z.infer<
  typeof BrowserPoolHostBootCompleteResponseSchema
>;

/** S4: pool host pulls one slot's exclusive egress credentials over HTTPS, signed by host key. */
export const browserPoolHostSlotEgressWindowMs = 5 * 60_000;

export const BrowserPoolHostSlotEgressRequestSchema = z.strictObject({
  v: z.literal(1),
  hostId: BrowserPoolHostIdSchema,
  slotId: BrowserPoolSlotIdSchema,
  /** ISO-8601 UTC timestamp with millisecond precision. */
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  /** 16 random bytes encoded as unpadded base64url. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  /** Standard base64 of a 64-byte Ed25519 signature by the host's enrolled key. */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
});
export type BrowserPoolHostSlotEgressRequest = z.infer<
  typeof BrowserPoolHostSlotEgressRequestSchema
>;

/** Exact UTF-8 bytes a pool host signs with its enrolled Ed25519 host key for slot egress. */
export function browserPoolHostSlotEgressSigningBytes(input: {
  readonly hostId: string;
  readonly slotId: string;
  readonly issuedAt: string;
  readonly nonce: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `opensteer-pool-slot-egress-v1\n${input.hostId}\n${input.slotId}\n${input.issuedAt}\n${input.nonce}`,
  );
}

export const ManagedBrowserPoolPublicKeysSchema = z.strictObject({
  homeKey: BrowserPoolSpkiBase64Schema,
  relayKey: BrowserPoolSpkiBase64Schema,
  ticketKey: z.strictObject({
    keyId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u),
    spki: BrowserPoolSpkiBase64Schema,
  }),
});
export type ManagedBrowserPoolPublicKeys = z.infer<typeof ManagedBrowserPoolPublicKeysSchema>;

export const BrowserPoolSlotGuestConfigSchema = z.strictObject({
  vcpus: z.number().int().min(1).max(32),
  memoryMib: z.number().int().min(256).max(65_536),
  /** Size of the slot's ext4 profile file (64 MiB to 1 TiB), matching the pool agent wire. */
  profileMib: z.number().int().min(64).max(1_048_576),
});
export type BrowserPoolSlotGuestConfig = z.infer<typeof BrowserPoolSlotGuestConfigSchema>;

export const BrowserPoolSlotAgentWriteSchema = z.strictObject({
  token: z.uuid(),
  kind: z.enum(["create", "replace-key", "delete"]),
  term: BrowserPoolTermSchema,
  hostId: BrowserPoolHostIdSchema,
  recoverAfter: z.iso.datetime().optional(),
  dispatched: z.boolean().optional(),
});
export type BrowserPoolSlotAgentWrite = z.infer<typeof BrowserPoolSlotAgentWriteSchema>;

export const BrowserPoolSlotStateSchema = z.enum(["active", "deleting", "deleted"]);
export type BrowserPoolSlotState = z.infer<typeof BrowserPoolSlotStateSchema>;

export const BrowserPoolSlotPhaseSchema = z.enum([
  "waiting_keys",
  "waiting_host",
  "provisioning",
  "ready",
  "updating_keys",
  "deleting",
  "deleted",
  "failed",
]);
export type BrowserPoolSlotPhase = z.infer<typeof BrowserPoolSlotPhaseSchema>;

export const BrowserPoolSlotDesiredSchema = z.strictObject({
  slotId: BrowserPoolSlotIdSchema,
  computerId: CloudComputerIdSchema,
  hostId: BrowserPoolHostIdSchema,
  hostGeneration: CloudComputerGenerationSchema,
  hostInternalIp: z.ipv4(),
  hostKey: BrowserPoolSpkiBase64Schema,
  term: BrowserPoolTermSchema,
  appliedTerm: BrowserPoolTermSchema.optional(),
  appliedHostGeneration: CloudComputerGenerationSchema.optional(),
  revision: CloudComputerDesiredRevisionSchema,
  state: BrowserPoolSlotStateSchema,
  phase: BrowserPoolSlotPhaseSchema,
  keys: ManagedBrowserPoolPublicKeysSchema.optional(),
  guest: BrowserPoolSlotGuestConfigSchema,
  controlKey: BrowserPoolSpkiBase64Schema.optional(),
  slotErased: z.boolean(),
  profileErased: z.boolean(),
  credentialsErased: z.boolean(),
  pendingAgentWrites: z.array(BrowserPoolSlotAgentWriteSchema).max(4).optional(),
});
export type BrowserPoolSlotDesired = z.infer<typeof BrowserPoolSlotDesiredSchema>;

export const BrowserPoolSlotDesiredPageSchema = z.object({
  after: BrowserPoolSlotIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const BrowserPoolSlotDesiredResponseSchema = z.strictObject({
  next: BrowserPoolSlotIdSchema.optional(),
  slots: z
    .array(BrowserPoolSlotDesiredSchema)
    .max(10_000)
    .refine((slots) => new Set(slots.map(({ slotId }) => slotId)).size === slots.length, {
      message: "Pool slot IDs must be unique",
    }),
});
export type BrowserPoolSlotDesiredResponse = z.infer<typeof BrowserPoolSlotDesiredResponseSchema>;

export const BrowserPoolSlotErrorSchema = z.enum([
  "The pool host rejected the slot administration request.",
  "The pool host reported a newer term for this browser slot.",
]);
export type BrowserPoolSlotError = z.infer<typeof BrowserPoolSlotErrorSchema>;

export const BrowserPoolSlotReportSchema = z
  .strictObject({
    slotId: BrowserPoolSlotIdSchema,
    revision: CloudComputerDesiredRevisionSchema,
    term: BrowserPoolTermSchema,
    phase: z.enum(["provisioning", "ready", "updating_keys", "deleting", "deleted", "failed"]),
    controlKey: BrowserPoolSpkiBase64Schema.nullable(),
    slotErased: z.boolean(),
    profileErased: z.boolean(),
    credentialsErased: z.boolean(),
    lastError: BrowserPoolSlotErrorSchema.nullable(),
  })
  .superRefine((report, context) => {
    if (report.phase === "ready" && report.controlKey === null) {
      context.addIssue({
        code: "custom",
        path: ["controlKey"],
        message: "A ready browser slot requires its control key",
      });
    }
    if (
      report.phase === "deleted" &&
      (!report.slotErased ||
        !report.profileErased ||
        !report.credentialsErased ||
        report.controlKey !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A deleted browser slot requires slot, profile, and credential erasure evidence",
      });
    }
    if ((report.phase === "failed") !== (report.lastError !== null)) {
      context.addIssue({
        code: "custom",
        path: ["lastError"],
        message: "Only failed browser slot reports carry an error",
      });
    }
  });
export type BrowserPoolSlotReport = z.infer<typeof BrowserPoolSlotReportSchema>;

export const BrowserPoolSlotCheckSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("begin-agent-write"),
    revision: CloudComputerDesiredRevisionSchema,
    write: BrowserPoolSlotAgentWriteSchema,
  }),
  z.strictObject({ operation: z.literal("finish-agent-write"), token: z.uuid() }),
  z.strictObject({
    operation: z.enum(["recover-agent-write", "send-agent-write"]),
    revision: CloudComputerDesiredRevisionSchema,
    token: z.uuid(),
  }),
  z.strictObject({
    operation: z.literal("mutate"),
    revision: CloudComputerDesiredRevisionSchema,
  }),
]);
export type BrowserPoolSlotCheck = z.infer<typeof BrowserPoolSlotCheckSchema>;

export const BrowserPoolSlotBumpTermRequestSchema = z.strictObject({
  revision: CloudComputerDesiredRevisionSchema,
  expectedTerm: BrowserPoolTermSchema,
});
export type BrowserPoolSlotBumpTermRequest = z.infer<typeof BrowserPoolSlotBumpTermRequestSchema>;

export const BrowserPoolSlotBumpTermResponseSchema = z.strictObject({
  bumped: z.boolean(),
  term: BrowserPoolTermSchema.optional(),
  revision: CloudComputerDesiredRevisionSchema.optional(),
});
export type BrowserPoolSlotBumpTermResponse = z.infer<typeof BrowserPoolSlotBumpTermResponseSchema>;

/** W4 + S5: Home registers its three public keys, signed by its pinned deployment Ed25519 key. */
export const managedBrowserPoolRegistrationWindowMs = 5 * 60_000;

export const ManagedBrowserPoolRegistrationDocumentSchema = z.strictObject({
  purpose: z.literal("opensteer-managed-browser-pool-registration"),
  documentVersion: z.literal(1),
  cloudComputerId: CloudComputerIdSchema,
  issuedAt: z.iso.datetime({ offset: true }),
  keys: ManagedBrowserPoolPublicKeysSchema,
});
export type ManagedBrowserPoolRegistrationDocument = z.infer<
  typeof ManagedBrowserPoolRegistrationDocumentSchema
>;

export const ManagedBrowserPoolRegistrationRequestSchema = z.strictObject({
  document: ManagedBrowserPoolRegistrationDocumentSchema,
  /** Base64url Ed25519 signature by the Home's pinned Host key. */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export type ManagedBrowserPoolRegistrationRequest = z.infer<
  typeof ManagedBrowserPoolRegistrationRequestSchema
>;

/** Exact bytes a pooled Home signs with its pinned Host key when registering its three slot keys. */
export function managedBrowserPoolRegistrationSigningBytes(
  input: ManagedBrowserPoolRegistrationDocument,
): Uint8Array {
  const document = ManagedBrowserPoolRegistrationDocumentSchema.parse(input);
  return new TextEncoder().encode(
    `opensteer-managed-browser-pool-registration-v1\0${JSON.stringify({
      cloudComputerId: document.cloudComputerId,
      documentVersion: document.documentVersion,
      issuedAt: document.issuedAt,
      keys: {
        homeKey: document.keys.homeKey,
        relayKey: document.keys.relayKey,
        ticketKey: {
          keyId: document.keys.ticketKey.keyId,
          spki: document.keys.ticketKey.spki,
        },
      },
      purpose: document.purpose,
    })}`,
  );
}

/** Public material handed back to the Home; matches ManagedBrowserPoolTarget + ManagedBrowserPoolRelay. */
export const ManagedBrowserPoolTargetSchema = z.strictObject({
  kind: z.literal("managed-pool"),
  agentUrl: z.url({ protocol: /^http$/u }),
  slotId: BrowserPoolSlotIdSchema,
  term: BrowserPoolTermSchema,
  agentKey: BrowserPoolSpkiBase64Schema,
  hostKey: BrowserPoolSpkiBase64Schema,
  relay: z.strictObject({
    host: z.ipv4(),
    port: z.number().int().min(1).max(65_535),
    relayHostKey: BrowserPoolSpkiBase64Schema,
  }),
});
export type ManagedBrowserPoolTarget = z.infer<typeof ManagedBrowserPoolTargetSchema>;

export const ManagedBrowserPoolTargetResponseSchema = z
  .strictObject({
    status: z.enum(["unregistered", "preparing", "ready", "failed"]),
    target: ManagedBrowserPoolTargetSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.status === "ready") !== (value.target !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "A browser pool target is present if and only if status is ready",
      });
    }
  });
export type ManagedBrowserPoolTargetResponse = z.infer<
  typeof ManagedBrowserPoolTargetResponseSchema
>;

export const browserPoolHostsDesiredPath = "/v1/browser-pool/hosts/desired";
export const browserPoolHostCheckPath = (id: BrowserPoolHostId) =>
  `/v1/browser-pool/hosts/${encodeURIComponent(id)}/check`;
export const browserPoolHostStatusPath = (id: BrowserPoolHostId) =>
  `/v1/browser-pool/hosts/${encodeURIComponent(id)}/status`;
export const browserPoolHostBootPath = (id: BrowserPoolHostId) =>
  `/v1/browser-pool/hosts/${encodeURIComponent(id)}/boot`;
export const browserPoolHostBootCompletePath = (id: BrowserPoolHostId) =>
  `/v1/browser-pool/hosts/${encodeURIComponent(id)}/boot-complete`;
export const browserPoolHostSlotEgressPath = (id: BrowserPoolHostId) =>
  `/v1/browser-pool/hosts/${encodeURIComponent(id)}/slot-egress`;

export const browserPoolSlotsDesiredPath = "/v1/browser-pool/slots/desired";
export const browserPoolSlotCheckPath = (slotId: BrowserPoolSlotId) =>
  `/v1/browser-pool/slots/${encodeURIComponent(slotId)}/check`;
export const browserPoolSlotStatusPath = (slotId: BrowserPoolSlotId) =>
  `/v1/browser-pool/slots/${encodeURIComponent(slotId)}/status`;
export const browserPoolSlotBumpTermPath = (slotId: BrowserPoolSlotId) =>
  `/v1/browser-pool/slots/${encodeURIComponent(slotId)}/bump-term`;

export const managedBrowserPoolRegistrationPath = "/v1/cloud-computers/browser-pool/registration";
export const managedBrowserPoolTargetPath = "/v1/cloud-computers/browser-pool/target";
