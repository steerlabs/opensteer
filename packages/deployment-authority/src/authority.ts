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

/** Personal and team transports negotiate their own mandatory contract version. */
export const hostApiVersion = 56;
/**
 * The team API this tree speaks, and the oldest peer it still serves. See the
 * compatibility policy in docs/teams.md before changing either; the wire
 * snapshot test refuses a breaking schema change without a bump.
 */
export const teamApiVersion = 4;
export const minimumTeamApiVersion = 4;
export const teamOAuthVersionParameter = "opensteer_team_api_version";
export const teamOidcStatePrefix = "ost-team-api-";
export const hostApiVersionHeader = "x-opensteer-api-version";
export const teamApiVersionHeader = "x-opensteer-team-api-version";
export const ApiNegotiationSchema = z.strictObject({
  kind: DeploymentKindSchema,
  apiVersion: z.number().int().positive(),
});
export type ApiNegotiation = z.infer<typeof ApiNegotiationSchema>;
export function apiNegotiation(kind: z.infer<typeof DeploymentKindSchema>): ApiNegotiation {
  return { kind, apiVersion: kind === "team" ? teamApiVersion : hostApiVersion };
}
export function apiVersionHeader(kind: z.infer<typeof DeploymentKindSchema>): string {
  return kind === "team" ? teamApiVersionHeader : hostApiVersionHeader;
}
/** What every caller that can set headers sends to a Host of `kind`. */
export function apiVersionHeaders(
  kind: z.infer<typeof DeploymentKindSchema>,
): Readonly<Record<string, string>> {
  return { [apiVersionHeader(kind)]: String(apiNegotiation(kind).apiVersion) };
}
/**
 * The Host's admission test and its callers' tests share this, so a caller
 * that forgets the epoch fails its own test instead of a person's Host.
 */
export function statesApiVersion(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  kind: z.infer<typeof DeploymentKindSchema>,
): boolean {
  const stated = headers[apiVersionHeader(kind)];
  return kind === "team"
    ? acceptsTeamApiVersion(stated)
    : stated === String(apiNegotiation(kind).apiVersion);
}

/**
 * Whether a team peer's stated version is one this tree serves. A newer peer
 * is admitted: it knows this side's version and keeps to its own minimum.
 */
export function acceptsTeamApiVersion(stated: unknown): boolean {
  const version =
    typeof stated === "number"
      ? stated
      : typeof stated === "string" && /^[1-9][0-9]{0,8}$/u.test(stated)
        ? Number(stated)
        : Number.NaN;
  return Number.isSafeInteger(version) && version >= minimumTeamApiVersion;
}

/** What a team peer older than this tree serves is told. */
export const teamApiVersionRefusal = `Update Opensteer: this team server needs team API version ${minimumTeamApiVersion} or newer.`;

/**
 * Optional features a Host may or may not serve. A capability is never a
 * substitute for the epoch: it says a feature exists, not that the shared
 * semantics still hold. Unknown names are ignored, so a newer Host may
 * advertise capabilities an older client has never heard of.
 */
export const HostCapabilitySchema = z.enum([
  /** Device setup and switches, plus explicit opt-in to device-access Request reads. */
  "devices-v1",
  "automatic-models-v1",
  "notification-preview-v1",
  "tab-reopen-v1",
  "iphone-apps-v1",
  "ownerViewWindows",
  "task-attachments",
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
   * returns the browser's one-use proof through `integration.authorization.return`
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
  /** A native-user Runner can inspect and update a person's installed engine CLI. */
  "harness-update-v1",
  /** A person can rename and delete their browser profiles. */
  "browser-profile-manage-v1",
  /** Clients can hold a voice call with its own agent through `voice.*`. */
  "voice-run-v1",
  /** Team Hosts: `POST /v1/team/session/exchange` turns an Account team identity assertion into a session. */
  "team-session-exchange-v1",
  /**
   * Team Hosts: one current reusable invite (`team.invite.reset`, `team.invite.current.get`)
   * and `POST /v1/team/invites/preview`.
   */
  "team-reusable-invites-v1",
  /** Team Hosts: setup adoption completion accepts Account's `hostedBootstrap`. */
  "team-hosted-bootstrap-v1",
  /**
   * Team Hosts: the invite page's `?authorize=` proves the invite, then continues to the app's
   * native sign-in (`teamInviteSignInUrl`). Older pages drop it and never return to the app.
   */
  "team-invite-native-continuation-v1",
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
export const HostDescriptorSchema = z.object({
  kind: DeploymentKindSchema,
  apiVersion: z.number().int().positive(),
  /** Team Hosts only: the oldest team API version they still serve. */
  minimumApiVersion: z.number().int().positive().optional(),
  authority: HostDiscoveryEnvelopeSchema,
  bootstrapMethods: z.array(HostBootstrapMethodSchema).max(4),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
});
export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

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
  minimumApiVersion: z.number().int().positive().optional(),
});

export function hostApiCompatibility(descriptor: unknown): HostApiCompatibility {
  const parsed = NegotiatedDescriptorSchema.safeParse(descriptor);
  if (parsed.success && parsed.data.kind === "team")
    return teamApiCompatibility(parsed.data.apiVersion ?? 0, parsed.data.minimumApiVersion);
  const advertised = parsed.success ? parsed.data.apiVersion : undefined;
  if (advertised === undefined || advertised < hostApiVersion) return "host-too-old";
  if (advertised > hostApiVersion) return "client-too-old";
  return "compatible";
}

/**
 * Whether this tree and a team peer overlap. A peer that predates
 * `minimumApiVersion` serves only its own version.
 */
export function teamApiCompatibility(
  peerVersion: number,
  peerMinimum = peerVersion,
): HostApiCompatibility {
  if (peerVersion < minimumTeamApiVersion) return "host-too-old";
  if (peerMinimum > teamApiVersion) return "client-too-old";
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
