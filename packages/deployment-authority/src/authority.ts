import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  DeploymentKindSchema,
  DeploymentShapeSchema,
  HostInstanceIdSchema,
} from "@opensteer/core";
import { z } from "zod";

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

/**
 * The personal Host API this tree speaks, and the oldest it still serves. Peers
 * speak the lower of their two current versions.
 *
 * 66 removed every team declaration from the personal wire at once, so both
 * numbers moved together: a released app speaking 65 reads a Home of this tree
 * as too new and asks to be updated. This is the one place where AGENTS.md rule
 * 6 ("wire changes that released apps read are additive and optional") does not
 * apply; removing the team server was the owner's decision.
 *
 * 67 removed `providerStateModes` from each environment: every Runner now runs
 * its engines as its own user, so the field said only whether it ran engines,
 * which its drivers already say. Nothing before this release is served.
 */
export const hostApiVersion = 67;
export const minimumHostApiVersion = 67;
/**
 * A personal caller states its minimum here: a Host from before the window
 * compares it for equality, which admits exactly the Hosts this tree still
 * serves. Its current version goes in `hostApiCurrentHeader`.
 */
export const hostApiVersionHeader = "x-opensteer-api-version";
export const hostApiCurrentHeader = "x-opensteer-api-current";
/** What every caller that can set headers sends to a Host. */
export function apiVersionHeaders(personalVersion?: number): Readonly<Record<string, string>> {
  return {
    [hostApiVersionHeader]: String(personalVersion ?? minimumHostApiVersion),
    [hostApiCurrentHeader]: String(personalVersion ?? hostApiVersion),
  };
}

type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

function statedVersion(stated: unknown): number | null {
  const version =
    typeof stated === "number"
      ? stated
      : typeof stated === "string" && /^[1-9][0-9]{0,8}$/u.test(stated)
        ? Number(stated)
        : Number.NaN;
  return Number.isSafeInteger(version) ? version : null;
}

/**
 * The personal API version a caller is served, or null when the two windows
 * do not overlap. A caller from before the window states one exact version.
 */
export function negotiatedHostApiVersion(headers: Headers): number | null {
  const minimum = statedVersion(headers[hostApiVersionHeader]);
  if (minimum === null) return null;
  const current =
    headers[hostApiCurrentHeader] === undefined
      ? minimum
      : statedVersion(headers[hostApiCurrentHeader]);
  if (current === null || current < minimum) return null;
  if (minimum > hostApiVersion || current < minimumHostApiVersion) return null;
  return Math.min(current, hostApiVersion);
}

/**
 * The Host's admission test and its callers' tests share this, so a caller
 * that forgets the version fails its own test instead of a person's Host.
 */
export function statesApiVersion(headers: Headers): boolean {
  return negotiatedHostApiVersion(headers) !== null;
}

/**
 * Optional features a Host may or may not serve. A capability is never a
 * substitute for the epoch: it says a feature exists, not that the shared
 * semantics still hold. Unknown names are ignored, so a newer Host may
 * advertise capabilities an older client has never heard of.
 */
export const HostCapabilitySchema = z.enum([
  /** Device setup and switches, plus explicit opt-in to device-access Request reads. */
  "devices-v1",
  "device-drivers-v1",
  "automatic-models-v1",
  "notification-preview-v1",
  "tab-reopen-v1",
  "iphone-apps-v1",
  "ownerViewWindows",
  /** Browser viewers can observe a target without requesting pictures. */
  "browser-target-control-v1",
  "browser-backend-v1",
  "browser-passkeys-v1",
  "browser-capture-region-v1",
  "browser-frame-window-v1",
  "browser-raster-demand-v1",
  "browser-search-suggestions-v1",
  /** This Host runs its own OAuth authorization server for native clients. */
  "native-oauth",
  /**
   * Account-brokered consent started from an app may finish in that app: it
   * returns the browser's one-use proof through `plugin.authorization.return`
   * instead of the browser signing into the Opensteer Account.
   */
  "integration-app-finish-v1",
  /**
   * `integration.*.authorization.begin` accepts `appReturnPort`, so a desktop
   * app's listener can receive that proof without a click.
   */
  "integration-app-return-port-v1",
  /** This Host accepts a Personal remote session delivered in a request header. */
  "personal-session-header",
  /** Threads can be renamed, and a new one can ask to be named from its first message. */
  "thread-titles-v1",
  /** `thread.sendMessage` and `voice.start` accept the sender's `origin`. */
  "message-origin-v1",

  "task-marks-v1",
  /**
   * A conversation's family can be read without its history: `triggers.list`
   * filters by `anchorThreadId`, and `thread.assignments.list` by `open`.
   */
  "task-family-v1",
  /** A subscription may omit snapshot message history and its windows. */
  "snapshot-messages-omit-v1",
  /** `thread.events.list` takes `turns`: a page of whole turns rather than a count of events. */
  "history-turns-v1",
  "node-detail-v1",
  "tool-output-detail-v1",
  "place-events-v1",
  "person-show-v1",
  /**
   * The Host moves quiet tasks to Done (`Thread.doneReason`), lists Done
   * tasks newest Done first (`tasks.list` `done`), keeps each person's
   * `viewer.quietTasks.update` choice, and reopens a Done task its writer may
   * reopen rather than refusing their message.
   */
  "quiet-tasks-v1",
  /** A Runner can inspect and update a person's installed engine CLI. */
  "harness-update-v1",
  /** `asset.urls` and `/media` serve image files on the hosting computer. */
  "agent-images-v1",
  /** A person can rename and delete their browser profiles. */
  "browser-profile-manage-v1",
  /** Clients can hold a voice call with its own agent through `voice.*`. */
  "voice-run-v1",
]);
export type HostCapability = z.infer<typeof HostCapabilitySchema>;

/**
 * `apiVersion` and `capabilities` sit outside the signed `authority` envelope
 * deliberately: they are not identity, they change on every Host upgrade, and
 * signing them would make a protocol bump rewrite the bytes every Account
 * directory has pinned. They carry no authority of their own — the verified
 * endpoint's transport is what makes them worth reading — and the epoch is
 * checked only to decide whether to keep talking, never to grant anything.
 *
 * The outer object is tolerant because it is a response: a Host one epoch ahead
 * may add a field, and an older client must still read the epoch that tells it
 * so rather than fail the parse.
 */
/**
 * A Home's answer to a client's fresh nonce, signed with its Host key: what
 * lets a client that saved a Home's key know the address still answers as
 * that Home before it sends it any credential.
 */
export const HostIdentityProofSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  signature: z.string().min(1).max(128),
});
export type HostIdentityProof = z.infer<typeof HostIdentityProofSchema>;

/** What every Host serves at `/.well-known/opensteer`, before a Home answers a proof nonce. */
export const HostDescriptorBaseSchema = z.object({
  kind: DeploymentKindSchema,
  /**
   * The Host's minimum: a client from before the window compares it for
   * equality, so it attaches while the Host still serves it.
   */
  apiVersion: z.number().int().positive(),
  /** The version the Host speaks to a caller as new as it. */
  currentApiVersion: z.number().int().positive().optional(),
  authority: HostDiscoveryEnvelopeSchema,
  bootstrapMethods: z.array(HostBootstrapMethodSchema).max(4),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
});

export const HostDescriptorSchema = HostDescriptorBaseSchema.extend({
  /** Present when a Personal request carried `?proof=<nonce>`. */
  identityProof: HostIdentityProofSchema.optional(),
});
export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

/** The bytes a Home signs to answer a nonce, naming the identity it answers as. */
export function hostIdentityProofBytes(input: {
  readonly nonce: string;
  readonly document: Pick<
    HostDiscoveryDocument,
    "canonicalOrigin" | "deploymentId" | "hostInstanceId"
  >;
}): Uint8Array {
  return new TextEncoder().encode(
    `opensteer-host-identity-proof-v1\0${JSON.stringify({
      nonce: input.nonce,
      canonicalOrigin: input.document.canonicalOrigin,
      deploymentId: input.document.deploymentId,
      hostInstanceId: input.document.hostInstanceId,
    })}`,
  );
}

/** Whether this tree can speak to the Host that served a descriptor. */
export type HostApiCompatibility = "client-too-old" | "compatible" | "host-too-old";

/**
 * Read a Host's epoch out of an unparsed descriptor.
 *
 * Deliberately tolerant of the whole document: a Host old enough to predate
 * the epoch serves a descriptor without one, and answering "that Host is too
 * old" is more use to a person than failing the descriptor parse.
 */
const NegotiatedDescriptorSchema = z.object({
  kind: DeploymentKindSchema,
  apiVersion: z.number().int().positive().optional(),
  currentApiVersion: z.number().int().positive().optional(),
});

export function hostApiCompatibility(descriptor: unknown): HostApiCompatibility {
  const parsed = NegotiatedDescriptorSchema.safeParse(descriptor);
  // A Host from before the window advertises one exact version.
  const minimum = parsed.success ? parsed.data.apiVersion : undefined;
  const current = parsed.success ? (parsed.data.currentApiVersion ?? minimum) : undefined;
  if (current === undefined || current < minimumHostApiVersion) return "host-too-old";
  if (minimum === undefined || minimum > hostApiVersion) return "client-too-old";
  return "compatible";
}

/** The advertised capabilities this tree knows the names of; the rest are noise. */
export function knownHostCapabilities(advertised: readonly string[]): readonly HostCapability[] {
  const known = new Set<HostCapability>();
  for (const name of advertised) {
    const parsed = HostCapabilitySchema.safeParse(name);
    if (parsed.success) known.add(parsed.data);
  }
  return [...known];
}

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

function sameDiscoveryDeployment(
  left: HostDiscoveryDeployment,
  right: HostDiscoveryDeployment,
): boolean {
  return left.kind === right.kind;
}

export function sameDiscoveryDocument(
  left: HostDiscoveryDocument,
  right: HostDiscoveryDocument,
): boolean {
  return (
    left.canonicalOrigin === right.canonicalOrigin &&
    left.deploymentId === right.deploymentId &&
    left.hostInstanceId === right.hostInstanceId &&
    left.hostKey.algorithm === right.hostKey.algorithm &&
    sameDiscoveryDeployment(left.deploymentShape, right.deploymentShape)
  );
}

interface HostAuthorityIdentity {
  readonly canonicalOrigin: string;
  readonly deploymentId: string;
  readonly hostInstanceId: string;
  readonly hostKeyFingerprint: string;
}

export function hostAuthorityIdentityMatches(
  discovery: HostDiscoveryDocument,
  hostKeyFingerprint: string,
  identity: HostAuthorityIdentity,
): boolean {
  return (
    discovery.deploymentId === identity.deploymentId &&
    discovery.hostInstanceId === identity.hostInstanceId &&
    discovery.canonicalOrigin === identity.canonicalOrigin &&
    hostKeyFingerprint === identity.hostKeyFingerprint
  );
}

export const apiVersionQueryParameter = "opensteer_api_version";
export const apiCurrentQueryParameter = "opensteer_api_current";

/** A browser cannot set WebSocket headers, so a socket states its versions in its URL. */
export function setApiVersionQuery(url: URL): URL {
  url.searchParams.set(apiVersionQueryParameter, String(minimumHostApiVersion));
  url.searchParams.set(apiCurrentQueryParameter, String(hostApiVersion));
  return url;
}
