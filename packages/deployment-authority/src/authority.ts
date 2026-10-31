import {
  CanonicalOriginSchema,
  DeploymentKindSchema,
  DeploymentIdSchema,
  DeploymentShapeSchema,
  HostInstanceIdSchema,
  WorkspaceBackingKindSchema,
  type WorkspaceBackingKind,
} from "@opensteer/core";
import { z } from "zod";

const CurrentHostDiscoveryDeploymentSchema = DeploymentShapeSchema.pick({
  defaultWorkspaceBacking: true,
  kind: true,
});

// Discovery envelopes issued before `backing` became a provisioning default
// remain valid signed Host identities. Keep their exact document shape so
// verification reconstructs the bytes the Host actually signed.
const LegacyHostDiscoveryDeploymentSchema = z.strictObject({
  backing: WorkspaceBackingKindSchema,
  kind: DeploymentKindSchema,
});

export const HostDiscoveryDeploymentSchema = z.union([
  CurrentHostDiscoveryDeploymentSchema,
  LegacyHostDiscoveryDeploymentSchema,
]);
export type HostDiscoveryDeployment = z.infer<typeof HostDiscoveryDeploymentSchema>;

export function hostDiscoveryDefaultWorkspaceBacking(
  deployment: HostDiscoveryDeployment,
): WorkspaceBackingKind {
  return "defaultWorkspaceBacking" in deployment
    ? deployment.defaultWorkspaceBacking
    : deployment.backing;
}

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
 * The client protocol epoch this tree speaks.
 *
 * It states one thing: whether the mandatory rpc and realtime semantics — the
 * command meanings, the event meanings and the frame sequence — are the same on
 * both ends. Bump it only when an older counterpart would misstate a meaning or
 * act unsafely, because a bump makes every app on the other epoch stop. Added
 * fields, kinds and features and removed fields are not a bump; Host
 * compatibility in docs/host-boundaries.md says how each stays compatible.
 *
 * Epoch 2 incorporates the Account's default semantics and makes the
 * `isDefault` response field mandatory. Epoch 1 peers cannot safely interpret
 * those meanings, so they must be refused rather than given a compatibility
 * fallback.
 */
// Epoch 3 separates messaging channel admission from execution authority and
// changes the channel policy commands.
// Epoch 4 permits complete model catalogs above the former 256-entry bound.
// Older clients reject that known field before they can render the picker.
// Epoch 5 admits multiple owner-scoped OAuth apps for one provider. Older clients
// require unique source kinds and at most two sources, so they cannot read that response.
// Epoch 6 keeps integration access pending through installation and pins account intent.
// It also admits the integrations module and computer connection method, which
// older clients' closed lists reject.
// Epoch 7 separates passive reports, queued work, and active-turn steering,
// and makes persistent Stop/Resume semantics part of the client contract.
// Epoch 8 requires the owner's approval on the target computer before computer
// app access is created or widened. Older clients cannot present that setup request.
// Epoch 9 requires the delegated Workspace scope read for the existing browser
// viewer, including its current Workspace. Epoch 8 Hosts lack that rpc member.
// Epoch 10 adds browser profile import Requests, whose kind and payload older
// clients cannot interpret. Browser Runners also declare snapshot format 2.
// Epoch 11 requires the durable Thread input queue read and the per-message
// steering promotion, which older Hosts do not serve.
// Epoch 12 makes a computer connection name one app: `integration.computer
// .setup.request` and `.set` carry the app identity, and the approval a
// desktop signs covers it. An epoch 11 client would omit the app and ask to
// approve "this Mac's macos-app", which is a different authority from the one
// the person is shown, and it cannot present a `computer.app.access` Request.
// Epoch 13 lets a person take back a queued message (`thread.input.cancel`),
// and the queue read names which items may be cancelled and stops listing a
// message a Run already seeds. An epoch 12 Host refuses the command outright.
// Epoch 14 replaces the single computer-use session projection with concurrent
// sessions and adds owner-selected per-app approval policy. It also changes the
// installed-app request and computer setup command contracts.
// Epoch 15 requires desktop-held approval keys, registered through owner consent
// and proof from the Mac. Clients must present missing-key setup and use the
// signed decision/Runner-stream flow instead of Runner-key approvals.
// Epoch 16 restores browser login sources with signed pairing invitations and
// requires their reads and approval flow on browser and Request surfaces.
// Epoch 17 replaces copy-into-a-new-profile with live browser sign-ins: the
// `browser.sign-in` Request, `browser.session.sign-in`, one-link Chrome
// connection and the reshaped browser source reads.
// Epoch 18 lets a person rearrange queued messages (`thread.input.move`, with
// `canMove` on each queue item) and places a queued message in the
// conversation where a Run takes it (`message.placed`). An epoch 17 Host
// refuses the command, and an epoch 17 client cannot parse the event.
// Epoch 19 requires bootstrap's stable Deployment ID to partition durable
// pending sends across accounts and routes. Attachment sends use immutable
// Host reservations and binary RPC; clients must retain their exact command
// until acknowledgement instead of inventing another send after a lost reply.
// Epoch 20 makes a Workspace's icon part of the contract: every Workspace view
// carries `icon` (a catalog name or null) that clients must draw, creation
// accepts one, and `workspace.icon.set` changes it. It also adds model-server
// settings, select source fields, and explicit keyless authentication. Upgrade
// Hosts before their Runners and clients.
// Epoch 22 replaces bulk unread polling with viewer state in pages and realtime,
// and carries rich query inputs in JSON bodies across all client transports.
// Epoch 23 finds model servers on a work location's computer
// (`harness.modelServers.discover`, Runner capability
// `model-server-discovery-v1`) and adds the `local-import` setup method, which
// copies a key a server keeps in its own settings into an account.
// Epoch 24 adds the macOS grants an app on a Mac may need beyond Full Disk
// Access and Automation — Contacts, Calendars and Reminders — as computer-app
// remedies. An epoch 23 client cannot parse a machines list that names one.
// Epoch 25 adds assignment lifecycle events, reads, and cancellation. Older
// clients cannot project a work Thread's objective or committed result.
// Epoch 26 lists work a conversation hands off: Threads carry `listed`, which
// Workspace snapshots and `workspace.threads.list` filter on, and `thread.listed`
// announces a Thread a conversation newly gives work. It adds `requests.list`
// and `host.requests-changed`, from which clients derive every "Needs you". An
// epoch 25 client would hide Home's tasks and miss what waits on its reader.
// It also adds Watch: `integration.computer.session.capture` and passive
// `mode=watch` browser sockets, which an epoch 26 client offers unasked.
// Epoch 27 includes the model label derived from pinned worker and assigning
// Runs in every Assignment summary. The task model must remain visible after
// its Thread is unloaded or reused, and older Hosts cannot supply that field.
// Epoch 28 names a completed Run's reply in `run.completed`. A conversation
// shows that message and folds everything else the Run wrote into its steps,
// so a client reading an older Host would have no reply to show.
// Epoch 29 moves streaming text out of the durable event log. Answers,
// reasoning and tool output arrive as `host.live` progress that follows the
// durable stream, and `thread.live.get` reads it afresh; an epoch 28 client
// would wait for deltas that no longer exist and show no streaming at all.
// It also makes Thread status, queue pause and pending count absolute through
// `thread.state-changed`, with sequence-stamped snapshots, pages and command answers.
// Epoch 30 decides notifications on the Host for every Deployment and sends
// each to its person's clients as `host.notification`, replacing the report
// lookup `thread.reportNotification.get`. It adds `viewer.timeZone.update`. An
// epoch 29 client would refuse the new frame and alert on reports, which are
// context for agents rather than messages to people.
// Epoch 31 lists each Trigger with its schedule, its latest Occurrence and its
// watch state, so the Automations page can say when each runs and whether it
// needs its owner without opening every one; an epoch 30 Host lists Triggers
// without them.
// Epoch 32 makes a person's message in their conversation contribute to the
// reply under way: the Host hands it to that Run, at its first dispatch, when
// its engine starts, or when its last open question is answered, instead of
// holding it for a later Run. Stopping a conversation's reply no longer pauses
// it and settles the follow-ups that reply had not taken as `stopped`, so a
// conversation never needs Resume. Ordinary sends never answer a Request. An
// epoch 31 client would show queue and Resume controls a conversation no longer
// has, and an epoch 31 Host would leave a newer client's conversation paused.
// Epoch 33 lets an Android phone be a computer: a machine's device may be a
// `phone` on `android`, a computer-use session may hold a phone's whole
// display rather than apps, a `computer.app.access` Request may name the
// `android-phone` definition with no app, an integration call's subject may
// name a phone, `runner.enrollment.createPhone` mints a phone,
// `runner.enrollment.retire` retires an enrollment its owner minted and
// `agentPhone.target.get` reads where a phone should reach this Host. An
// epoch 32 client would refuse every machines list and Request list that
// holds a phone.
// It also records conversation browser usage and exact tab destinations, and
// app capture names the session and app rather than following the last observation.
// It adds the `browser-page` message part, per-page `viewport.set`, the browser
// socket's `viewport.follow` that sizes a page to the person's view, and the
// `host.browser-presence`, `host.browser-usage-changed` and `host.computer-presence`
// patches that replace rereading a Workspace when a page or an agent's activity changes.
// Older clients cannot supply that app identity or parse those parts and patches;
// older Hosts cannot supply usage.
// It lists a person's tasks across every Workspace with `tasks.list`,
// announced by `host.tasks-changed`, and adds each reader's own placement of a
// task in Done or Tasks (`placement` in read state, `thread.done.set`), which an
// older Host neither lists nor records.
// Epoch 34 lists integration tools without their input and output schemas:
// `integration.platform.get` carried every operation's schemas, megabytes for
// one large API, and only describing one operation reads them. An epoch 33
// client requires those fields and would refuse every integrations dashboard.
// Epoch 35 adds a site's icon (`favicon`) to browser tabs. An epoch 34 client's
// strict tab schema refuses that field, so it cannot read the new browser state.
// Epoch 36 lets an API-key connect name the connection it reconnects
// (`connectionId`), the only way to repair a key the provider names no account
// for. An epoch 35 Host's strict command schema refuses that field.
// Epoch 37 marks agent-proposed Requests with `presentation.agentProposed` instead
// of quoting their titles, and carries API-key destinations and pre-save check
// facts in definition summaries. An epoch 36 client would show neither.
// Epoch 38 says why an integration account needs its owner (`statusReason`), so
// a GitHub account waiting for repositories is told apart from one that must
// sign in again. An epoch 37 Host states neither apart.
// Epoch 39 carries an agent's one-line `description` in proposal summaries; an
// epoch 38 client's strict schema refuses it.
// Epoch 40 adds typed native context, tab catalogs and target-specific browser viewing.
// Epoch 41 adds identity-targeted tab opens with session adoption, independent owner-view
// commands/notices, producer-owned input lanes, aiming geometry/modifiers and Control
// presentation credit.
// Epoch 42 unifies phone live display under independent task/owner authority and removes phone viewer capture.
// Epoch 43 carries authenticated needs-update machine state instead of reporting incompatible producers as offline.
// Epoch 44 removes browser surface/tab type: opener provenance orders one flat list of tabs.
// Epoch 45 carries phone self-update progress and system-confirmation machine states.
// Epoch 46 requires Mac integrations 5 starts to carry the remaining end-to-end startup budget.
// Epoch 47 removes phone approval prompts and keys, lets owners set phone access
// from any client, and requires Android integrations protocol 4. An epoch 46
// client would wait for a phone prompt and misstate a keyless phone as unfinished.
// Epoch 48 adds Workspace-scoped Passwords Requests. Epoch-47 clients require a
// Browser Session and describe consent as browser-only.
// Shared Done is capability-gated (`shared-task-done-v1`) and uses a distinct
// command. Epoch-48 read fields remain available as display-only projections.
export const hostApiVersion = 48;

/**
 * Optional features a Host may or may not serve. A capability is never a
 * substitute for the epoch: it says a feature exists, not that the shared
 * semantics still hold. Unknown names are ignored, so a newer Host may
 * advertise capabilities an older client has never heard of.
 */
export const HostCapabilitySchema = z.enum([
  "screen-show-v1",
  "workspace-tab-reopen-v1",
  "iphone-apps-v1",
  "ownerViewWindows",
  "chat-attachments",
  /** Browser viewers can observe a target without requesting pictures. */
  "browser-target-control-v1",
  "browser-passkeys-v1",
  "browser-capture-region-v1",
  "browser-frame-window-v1",
  "browser-raster-demand-v1",
  "browser-search-suggestions-v1",
  /** This Host runs its own OAuth authorization server for native clients. */
  "native-oauth",
  /** This Host accepts a Personal remote session delivered in a request header. */
  "personal-session-header",
  /** Threads can be renamed, and a new one can ask to be named from its first message. */
  "thread-titles-v1",
  /**
   * Threads carry a symbol and a colour, a person can change a Thread's symbol
   * (`thread.icon.set`) and a specialist's colour (`workspace.color.set`).
   */
  "task-marks-v1",
  /** A subscription may omit snapshot message history and its windows. */
  "snapshot-messages-omit-v1",
  "shared-task-done-v1",
  /** A person can rename and delete their browser profiles. */
  "browser-profile-manage-v1",
  /** Clients can hold a voice call through `voice.*` (see docs/voice.md). */
  "voice-v1",
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
  apiVersion: z.number().int().positive(),
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
  apiVersion: z.number().int().positive().optional(),
});

export function hostApiCompatibility(descriptor: unknown): HostApiCompatibility {
  const parsed = NegotiatedDescriptorSchema.safeParse(descriptor);
  const advertised = parsed.success ? parsed.data.apiVersion : undefined;
  if (advertised === undefined || advertised < hostApiVersion) return "host-too-old";
  if (advertised > hostApiVersion) return "client-too-old";
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
  return (
    hostDiscoveryDefaultWorkspaceBacking(left) === hostDiscoveryDefaultWorkspaceBacking(right) &&
    left.kind === right.kind
  );
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
