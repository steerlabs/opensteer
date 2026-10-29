import {
  IsoDateTimeSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type RunnerId,
} from "@opensteer/core";
import { z } from "zod";
import {
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryHeartbeatSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryTicketSchema,
  RunnerAuxiliaryWelcomeSchema,
} from "./runner-auxiliary.js";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const ShellSessionIdSchema = z
  .string()
  .regex(new RegExp(`^shs_${uuid}$`, "i"))
  .brand<"ShellSessionId">();
export type ShellSessionId = z.infer<typeof ShellSessionIdSchema>;

/**
 * The exact byte layout of an `ssh-ed25519` public key blob: the algorithm
 * name string, then the 32-byte public key, each length-prefixed. A caller
 * pins this into `known_hosts`, so anything that is not this precise structure
 * is refused rather than trusted as a host key.
 */
const sshEd25519KeyBlobLength = 51;
const sshEd25519KeyPrefix = Object.freeze([
  0, 0, 0, 11, 115, 115, 104, 45, 101, 100, 50, 53, 53, 49, 57, 0, 0, 0, 32,
]);

function decodeBase64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Whether a string is a single canonical `ssh-ed25519` public key.
 *
 * A base64 regex is not enough: a host key is pinned and then trusted, so it
 * must decode to exactly the 51-byte ed25519 blob — the algorithm name, the
 * 32-byte key, nothing before or after — and the base64 must be its canonical
 * encoding, so two spellings can never name the same machine.
 */
export function isCanonicalEd25519SshPublicKey(value: string): boolean {
  const space = value.indexOf(" ");
  if (space === -1 || value.indexOf(" ", space + 1) !== -1) return false;
  if (value.slice(0, space) !== "ssh-ed25519") return false;
  const encoded = value.slice(space + 1);
  const bytes = decodeBase64ToBytes(encoded);
  if (!bytes || bytes.length !== sshEd25519KeyBlobLength) return false;
  for (let index = 0; index < sshEd25519KeyPrefix.length; index += 1) {
    if (bytes[index] !== sshEd25519KeyPrefix[index]) return false;
  }
  // Reject a non-canonical encoding (padding, whitespace, alphabet) by
  // requiring the bytes to round-trip to the exact string presented.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary) === encoded;
}

const ShellHostPublicKeySchema = z
  .string()
  .max(128)
  .refine(isCanonicalEd25519SshPublicKey, "Machine host key must be a canonical ssh-ed25519 key");

/**
 * What a computer offers callers that reach it over SSH.
 *
 * The host key is the only thing a caller can pin, so it travels in the module
 * descriptor rather than a column of its own: it is a claim the machine makes
 * about itself, persisted with everything else the machine claims.
 */
export const RunnerShellModuleSchema = z.object({
  /**
   * Whether macOS lets the process running this computer's Opensteer Runner
   * open protected data — Messages, Mail, Safari data, Desktop, Documents,
   * Downloads.
   *
   * Commands the Runner starts inherit that process's macOS identity, but their
   * existing machine-access and sandbox rules still decide whether they may run
   * and what they may reach. The helper probes actual access rather than reading
   * a setting, because macOS offers no API for the fact, and the Runner announces
   * it again whenever the probe's answer changes
   * (`runner.shell.full-disk-access`). Linux has no such gate and omits it.
   */
  fullDiskAccess: z.boolean().optional(),
  hostPublicKey: ShellHostPublicKeySchema,
  platform: z.enum(["darwin", "linux"]),
});
export type RunnerShellModule = z.infer<typeof RunnerShellModuleSchema>;

export const machineAccessMaxShares = 32;
/**
 * How long a share path may be, counted the way the machine that enforces it
 * counts: UTF-8 bytes.
 *
 * The helper on the far side measures bytes, so a path this side accepted as
 * 1,024 "characters" could be 3,000 bytes there — refused at init, taking
 * every session to that computer down with it. One unit, measured once.
 */
export const machineAccessSharePathMaxBytes = 1_024;

const sharePathEncoder = new TextEncoder();

/** A share path's length in the unit the helper enforces. */
export function machineAccessSharePathByteLength(path: string): number {
  return sharePathEncoder.encode(path).length;
}

export const MachineAccessShareSchema = z.strictObject({
  mode: z.enum(["read", "read-write"]),
  // A UTF-16 unit is never more than a UTF-8 byte, so this bound admits every
  // path the byte rule below accepts and nothing enormous; the exact rule
  // lives in `machineAccessShareComponents`, which every surface shares.
  path: z.string().min(1).max(machineAccessSharePathMaxBytes),
});
const MachineAccessShareViewSchema = z.object(MachineAccessShareSchema.shape);
export type MachineAccessShare = z.infer<typeof MachineAccessShareSchema>;

export const MachineAccessReachSchema = z.enum(["nobody", "owner", "deployment"]);
export type MachineAccessReach = z.infer<typeof MachineAccessReachSchema>;

/**
 * The components of a share path, or null when the path is not one this
 * Deployment will store.
 *
 * Shares are compared by component and never by string prefix, because
 * `/Users/person/Pictures2` is not inside `/Users/person/Pictures`. A path that is
 * not already in its component-normalized form is refused rather than
 * rewritten: the person typed a folder, and silently storing a different one
 * would make the Computers page disagree with what the machine enforces.
 *
 * A NUL is refused outright: it cannot survive the C string the helper opens
 * the folder with, so a path carrying one names a different folder there.
 */
export function machineAccessShareComponents(path: string): readonly string[] | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  if (machineAccessSharePathByteLength(path) > machineAccessSharePathMaxBytes) return null;
  const components = path.slice(1).split("/");
  if (components.length === 0) return null;
  for (const component of components) {
    if (component === "" || component === "." || component === "..") return null;
  }
  return components;
}

function shareIsInside(inner: readonly string[], outer: readonly string[]): boolean {
  if (outer.length > inner.length) return false;
  return outer.every((component, index) => component === inner[index]);
}

/**
 * Every reason a set of shares cannot be stored, each a complete sentence that
 * names the folders involved.
 */
export function machineAccessShareIssues(shares: readonly MachineAccessShare[]): readonly string[] {
  const issues: string[] = [];
  const accepted: { readonly components: readonly string[]; readonly path: string }[] = [];
  for (const share of shares) {
    if (share.path.includes("\0")) {
      issues.push("A shared folder path cannot contain a NUL character.");
      continue;
    }
    const bytes = machineAccessSharePathByteLength(share.path);
    if (bytes > machineAccessSharePathMaxBytes) {
      issues.push(
        `${share.path} is ${bytes.toLocaleString("en-US")} bytes long; a shared folder path must be at most ${machineAccessSharePathMaxBytes.toLocaleString("en-US")} bytes of UTF-8.`,
      );
      continue;
    }
    const components = machineAccessShareComponents(share.path);
    if (!components) {
      issues.push(
        `${share.path} must be an absolute folder path with no "." or ".." component, no repeated slash, and no trailing slash.`,
      );
      continue;
    }
    const duplicate = accepted.find((other) => other.path === share.path);
    if (duplicate) {
      issues.push(`${share.path} is shared twice.`);
      continue;
    }
    const outer = accepted.find((other) => shareIsInside(components, other.components));
    if (outer) {
      issues.push(`${share.path} is inside ${outer.path}, which is already shared.`);
      continue;
    }
    const inner = accepted.find((other) => shareIsInside(other.components, components));
    if (inner) {
      issues.push(`${share.path} contains ${inner.path}, which is already shared.`);
      continue;
    }
    accepted.push({ components, path: share.path });
  }
  return issues;
}

/**
 * What one computer permits callers from other computers.
 *
 * `commands` is deliberately not a list of allowed commands: they run as the
 * OS account that runs the Runner, so the switch is the whole truth about what
 * it grants. Only folder shares are enforced, because only they can be.
 */
export const MachineAccessPolicySchema = z
  .strictObject({
    commands: z.boolean(),
    forwarding: z.boolean(),
    reach: MachineAccessReachSchema,
    shares: z.array(MachineAccessShareSchema).max(machineAccessMaxShares),
  })
  .superRefine((policy, context) => {
    for (const message of machineAccessShareIssues(policy.shares)) {
      context.addIssue({ code: "custom", message, path: ["shares"] });
    }
  });
export const MachineAccessPolicyViewSchema = z
  .object({
    ...MachineAccessPolicySchema.shape,
    shares: z.array(MachineAccessShareViewSchema).max(machineAccessMaxShares),
  })
  .superRefine((policy, context) => {
    for (const message of machineAccessShareIssues(policy.shares)) {
      context.addIssue({ code: "custom", message, path: ["shares"] });
    }
  });
export type MachineAccessPolicy = z.infer<typeof MachineAccessPolicySchema>;

export const machineAccessPolicyDefault: MachineAccessPolicy = Object.freeze({
  commands: false,
  forwarding: false,
  reach: "nobody",
  shares: [],
});

/** Who the target is serving, so its audit and its refusals can say so. */
export const ShellSessionAuthoritySchema = z.strictObject({
  callerMachineName: z.string().min(1).max(160),
  policyRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestedBy: UserIdSchema,
  runId: RunIdSchema,
  sessionId: ShellSessionIdSchema,
  /** The reservation time, the single instant every surface reports. */
  startedAt: IsoDateTimeSchema,
  threadId: ThreadIdSchema,
  threadTitle: z.string().max(240),
  workspaceId: WorkspaceIdSchema,
});
export type ShellSessionAuthority = z.infer<typeof ShellSessionAuthoritySchema>;

export const ShellCloseReasonSchema = z.enum([
  "client-closed",
  "target-closed",
  "run-ended",
  "stopped-by-owner",
  "policy-changed",
  "machine-revoked",
  "machine-disconnected",
  "host-shutdown",
  "protocol-error",
  "idle-timeout",
  "open-timeout",
  "open-failed",
]);
export type ShellCloseReason = z.infer<typeof ShellCloseReasonSchema>;

/** The SSH channel an audited request belongs to, as the wire numbers them. */
const ShellAuditChannelSchema = z.number().int().nonnegative().max(4_294_967_295);
const ShellAuditPathSchema = z.string().min(1).max(1_024);

/**
 * One audited SSH request, persisted exactly as the helper reported it.
 *
 * `truncated` is the only member the Host writes itself, once, when a session
 * produced more requests than a row may hold.
 */
export const ShellAuditEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    channel: ShellAuditChannelSchema,
    command: z.string().max(4_096),
    commandTruncated: z.literal(true).optional(),
    kind: z.literal("exec"),
  }),
  z.strictObject({
    channel: ShellAuditChannelSchema,
    kind: z.literal("sftp.open"),
    mode: z.enum(["read", "write"]),
    path: ShellAuditPathSchema,
  }),
  z.strictObject({
    channel: ShellAuditChannelSchema,
    kind: z.literal("sftp.mutate"),
    op: z.enum(["mkdir", "remove", "rename", "setstat"]),
    path: ShellAuditPathSchema,
    target: ShellAuditPathSchema.optional(),
  }),
  z.strictObject({
    channel: ShellAuditChannelSchema,
    host: z.string().min(1).max(255),
    kind: z.literal("forward"),
    port: z.number().int().min(1).max(65_535),
  }),
  z.strictObject({
    channel: ShellAuditChannelSchema.optional(),
    detail: z.string().max(512),
    kind: z.literal("denied"),
    what: z.enum(["exec", "shell", "pty", "env", "subsystem", "sftp", "forward", "global-request"]),
  }),
  z.strictObject({
    channel: ShellAuditChannelSchema,
    exitSignal: z.string().min(1).max(64).optional(),
    exitStatus: z.number().int().min(0).max(255).optional(),
    kind: z.literal("channel.closed"),
  }),
  z.strictObject({ kind: z.literal("truncated") }),
]);
const ShellAuditEventViewSchema = z.discriminatedUnion("kind", [
  z.object(ShellAuditEventSchema.options[0].shape),
  z.object(ShellAuditEventSchema.options[1].shape),
  z.object(ShellAuditEventSchema.options[2].shape),
  z.object(ShellAuditEventSchema.options[3].shape),
  z.object(ShellAuditEventSchema.options[4].shape),
  z.object(ShellAuditEventSchema.options[5].shape),
  z.object(ShellAuditEventSchema.options[6].shape),
]);
export type ShellAuditEvent = z.infer<typeof ShellAuditEventSchema>;

/** At most 1,000 reported requests plus the one marker that says so. */
export const shellAuditEventCap = 1_000;

const shellFrameBase = { ...RunnerAuxiliaryFrameFenceSchema.shape } as const;

export const HostToShellModuleMessageSchema = z.discriminatedUnion("type", [
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerAuxiliaryRejectedSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  z.strictObject({
    ...shellFrameBase,
    authority: ShellSessionAuthoritySchema,
    dataTicket: RunnerAuxiliaryTicketSchema,
    /**
     * This computer's display name, as the Deployment knows it. The helper puts
     * it in the sentences it refuses with, so a person reads the name they gave
     * the machine rather than whatever its operating system calls itself.
     */
    machineName: z.string().min(1).max(160),
    policy: MachineAccessPolicySchema,
    sessionId: ShellSessionIdSchema,
    type: z.literal("host.shell.session.open"),
  }),
  z.strictObject({
    ...shellFrameBase,
    reason: ShellCloseReasonSchema,
    sessionId: ShellSessionIdSchema,
    type: z.literal("host.shell.session.close"),
  }),
]);
export type HostToShellModuleMessage = z.infer<typeof HostToShellModuleMessageSchema>;

/** Everything a routing call may send, which excludes the handshake itself. */
export type RoutedHostToShellModuleMessage = Extract<
  HostToShellModuleMessage,
  { readonly type: "host.shell.session.open" | "host.shell.session.close" }
>;

export const ShellModuleToHostMessageSchema = z.discriminatedUnion("type", [
  RunnerAuxiliaryHeartbeatSchema,
  z.strictObject({
    ...shellFrameBase,
    sessionId: ShellSessionIdSchema,
    type: z.literal("runner.shell.session.opened"),
  }),
  z.strictObject({
    ...shellFrameBase,
    error: z.strictObject({
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(512),
    }),
    sessionId: ShellSessionIdSchema,
    type: z.literal("runner.shell.session.rejected"),
  }),
  z.strictObject({
    ...shellFrameBase,
    /**
     * Audited requests this session produced that never reached the Host —
     * dropped by the helper, by the Runner's bounded queues, or abandoned at
     * cleanup. Any positive count becomes the one `truncated` marker the
     * history carries, so an incomplete history never looks complete.
     */
    auditDropped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    detail: z.string().min(1).max(512).optional(),
    reason: ShellCloseReasonSchema,
    sessionId: ShellSessionIdSchema,
    type: z.literal("runner.shell.session.closed"),
  }),
  z.strictObject({
    ...shellFrameBase,
    event: ShellAuditEventSchema,
    sessionId: ShellSessionIdSchema,
    type: z.literal("runner.shell.event"),
  }),
]);
export type ShellModuleToHostMessage = z.infer<typeof ShellModuleToHostMessageSchema>;

/** Everything the module reports, which excludes the shared heartbeat. */
export type ShellModuleEvent = Exclude<
  ShellModuleToHostMessage,
  { readonly type: "runner.auxiliary.heartbeat" }
>;

/**
 * What the Host signs into the one-use credential the target presents on its
 * data socket.
 *
 * It carries the complete auxiliary fence — not just the Runner and boot, but
 * the exact connection, lease and stream the reservation named — so the data
 * socket the target opens is checked against that one stream and nothing beside
 * it. The distinct `type` marker keeps a data ticket from ever being read as an
 * auxiliary stream ticket even though the same key signs both.
 */
export const ShellDataTicketClaimsSchema = z.strictObject({
  ...RunnerAuxiliaryFrameFenceSchema.shape,
  audience: z.literal("opensteer-shell-data"),
  expiresAt: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  module: z.literal("shell"),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  sessionId: ShellSessionIdSchema,
  type: z.literal("opensteer.shell.data-ticket"),
});
export type ShellDataTicketClaims = z.infer<typeof ShellDataTicketClaimsSchema>;

/**
 * Why a caller was refused.
 *
 * There is deliberately no "unsupported platform" code: Runner identity has no
 * general platform field and a Windows machine never publishes the shell
 * descriptor at all, so "does not advertise the module" is the only state a
 * Host can actually observe, and `module_unavailable` is the truthful name for
 * it.
 */
export const ShellConnectErrorCodeSchema = z.enum([
  "run_invalid",
  "target_unknown",
  "target_offline",
  "module_unavailable",
  "reach_denied",
  "too_many_sessions",
]);
export type ShellConnectErrorCode = z.infer<typeof ShellConnectErrorCodeSchema>;

/** The refusal body the proxy prints verbatim, so it is a whole sentence. */
export const ShellConnectErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ShellConnectErrorCodeSchema,
    message: z.string().min(1).max(512),
  }),
});
export type ShellConnectError = z.infer<typeof ShellConnectErrorSchema>;

/** One line from the ssh proxy to the Run's relay socket. */
export const ShellRelayRequestSchema = z.strictObject({ target: RunnerIdSchema });
export type ShellRelayRequest = z.infer<typeof ShellRelayRequestSchema>;

/** One line back. After `ok` the socket carries raw SSH bytes and nothing else. */
export const ShellRelayResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ message: z.string().min(1).max(512), ok: z.literal(false) }),
]);
export type ShellRelayResponse = z.infer<typeof ShellRelayResponseSchema>;

export const machineAliasMaxLength = 63;

export const MachineAliasSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const machineAccessMaxMachines = 32;
/** The serialized machineAccess JSON budget, well inside the primary frame. */
export const machineAccessMaxSerializedBytes = 128 * 1_024;

export const MachineAccessRunMachineSchema = z.strictObject({
  alias: MachineAliasSchema,
  commands: z.boolean(),
  forwarding: z.boolean(),
  /** The macOS grant as the machine last announced it; null where none exists. */
  fullDiskAccess: z.boolean().nullable(),
  hostPublicKey: ShellHostPublicKeySchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  name: z.string().min(1).max(160),
  platform: RunnerShellModuleSchema.shape.platform,
  runnerId: RunnerIdSchema,
  shares: z.array(MachineAccessShareSchema).max(machineAccessMaxShares),
  status: z.enum(["online", "offline"]),
});
export type MachineAccessRunMachine = z.infer<typeof MachineAccessRunMachineSchema>;

/**
 * The Run's computer and the other computers it may reach, fixed at dispatch.
 *
 * It is a snapshot on purpose: the ssh config, the known hosts and the note in
 * the turn context are written once at Run setup, and a list that changed
 * underneath them would describe a machine the Run cannot address. Both bounds
 * are the wire contract — at most 32 entries and at most 128 KiB serialized —
 * so a Deployment full of heavily-shared machines cannot push the Run command
 * past its own size cap.
 */
export const MachineAccessRunContextSchema = z
  .strictObject({
    callerMachineName: z.string().min(1).max(160),
    machines: z.array(MachineAccessRunMachineSchema).max(machineAccessMaxMachines),
    /** Reachable computers beyond the budget, counted rather than listed. */
    omittedMachines: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((context, issues) => {
    // The whole object, not just the list inside it: what travels in the Run
    // command is this object, so a list that fits with nothing to spare and an
    // enclosing object that does not is still over the budget.
    if (serializedByteLength(context) > machineAccessMaxSerializedBytes) {
      issues.addIssue({
        code: "custom",
        message: "Reachable machines exceed the serialized machine-access budget",
        path: [],
      });
    }
  });
export type MachineAccessRunContext = z.infer<typeof MachineAccessRunContextSchema>;

function serializedByteLength(value: unknown): number {
  let bytes = 0;
  for (const codePoint of JSON.stringify(value)) {
    const code = codePoint.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Keeps a Run's reachable-machine list inside both budgets.
 *
 * Which machines survive is decided by name, with the runner id breaking ties,
 * because that is the order a person reads them in and the one a Deployment
 * that grows a machine can predict; alias allocation is a separate question and
 * stays ordered by runner id. Dropping is from the end and always whole — never
 * from the middle, and never by truncating a share path or a machine's policy —
 * until the count and the serialized size both hold. The size measured is the
 * complete `machineAccess` object, including the Run computer name and omission count, because that
 * whole object is what travels inside the Run command.
 */
export function budgetReachableMachines(
  callerMachineName: string,
  machines: readonly MachineAccessRunMachine[],
): MachineAccessRunContext {
  const eligible = [...machines].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en") ||
      (left.runnerId < right.runnerId ? -1 : left.runnerId > right.runnerId ? 1 : 0),
  );
  const kept = eligible.slice(0, machineAccessMaxMachines);
  const budgeted = () =>
    serializedByteLength({
      callerMachineName,
      machines: kept,
      omittedMachines: eligible.length - kept.length,
    });
  while (kept.length > 0 && budgeted() > machineAccessMaxSerializedBytes) kept.pop();
  return MachineAccessRunContextSchema.parse({
    callerMachineName,
    machines: kept,
    omittedMachines: eligible.length - kept.length,
  });
}

function machineAliasSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "" ? "computer" : slug;
}

function cutAlias(alias: string, length: number): string {
  return alias.length <= length ? alias : alias.slice(0, length).replace(/-+$/u, "");
}

/**
 * The SSH host alias each reachable computer answers to inside one Run.
 *
 * Allocation is deterministic in `runnerId` order against a single used set, so
 * two computers with the same name — or one literally named `example-mac` —
 * always land on the same aliases for the same Run input. The initial candidate
 * is cut to 63; a colliding one is retried as `<base cut to 63−len(suffix)>-N`
 * so the numbered form never grows past the limit either.
 */
export function allocateMachineAliases(
  machines: readonly { readonly name: string; readonly runnerId: RunnerId }[],
): ReadonlyMap<RunnerId, string> {
  const used = new Set<string>();
  const aliases = new Map<RunnerId, string>();
  const ordered = [...machines].sort((left, right) =>
    left.runnerId < right.runnerId ? -1 : left.runnerId > right.runnerId ? 1 : 0,
  );
  for (const machine of ordered) {
    if (aliases.has(machine.runnerId)) continue;
    const slug = machineAliasSlug(machine.name);
    let alias = cutAlias(slug, machineAliasMaxLength);
    for (let suffix = 2; used.has(alias); suffix += 1) {
      const tail = `-${suffix}`;
      alias = `${cutAlias(slug, machineAliasMaxLength - tail.length)}${tail}`;
    }
    used.add(alias);
    aliases.set(machine.runnerId, alias);
  }
  return aliases;
}

export const ShellSessionSummarySchema = z.object({
  bytesIn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytesOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  callerMachineName: z.string().min(1).max(160),
  id: ShellSessionIdSchema,
  requestedBy: UserIdSchema,
  runId: RunIdSchema,
  startedAt: IsoDateTimeSchema,
  threadId: ThreadIdSchema,
  threadTitle: z.string().max(240),
});
export type ShellSessionSummary = z.infer<typeof ShellSessionSummarySchema>;

export const ShellSessionHistoryEntrySchema = ShellSessionSummarySchema.extend({
  endReason: ShellCloseReasonSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  events: z.array(ShellAuditEventViewSchema).max(shellAuditEventCap + 1),
});
export type ShellSessionHistoryEntry = z.infer<typeof ShellSessionHistoryEntrySchema>;

export const ShellHistoryCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const machineAccessHistoryMaxSessions = 50;
/** How many sessions one computer serves at once, pending reservations counted. */
export const machineAccessMaxActiveSessions = 64;
/** How many sessions one Run holds at once, pending reservations counted. */
export const machineAccessMaxRunSessions = 16;

/**
 * The largest reassembled message either shell data socket accepts.
 *
 * Both ends chunk larger reads rather than growing a frame: the cap is what
 * lets a receiver refuse a hostile sender before buffering it, and it is small
 * enough that one message can never monopolise the queue budget below.
 */
export const shellDataMessageMaxBytes = 256 * 1_024;

/** Application bytes one direction may hold before its source is paused. */
export const shellDataQueueMaxBytes = 1_024 * 1_024;

/**
 * One refusal, as the thing that prints it needs it.
 *
 * Every machine-access refusal ends up in front of a person — the ssh proxy
 * prints the Host's sentence verbatim, the relay prints its own, the helper
 * prints its own — so each has to read as a sentence rather than as a fragment
 * of a stack trace. This is the one place that decides what that means, so the
 * Host, the Runner and the helper cannot drift into three punctuation rules.
 */
export function shellSentence(message: string, fallback: string): string {
  const trimmed = message.trim() || fallback.trim() || "Shell connection failed";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}
