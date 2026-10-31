import { z } from "zod";
import { ComputerAppIdentityViewSchema } from "./computer-app.js";
import {
  AssignmentIdSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  CausalChainIdSchema,
  DeploymentIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  HostInstanceIdSchema,
  MessageIdSchema,
  ProviderSessionIdSchema,
  ExecutionNodeIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  SequenceSchema,
  StorageAuthorityIdSchema,
  ThreadIdSchema,
  TriggerIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerRevisionIdSchema,
  TriggerWatchActivationIdSchema,
  UserIdSchema,
  WorkspaceBindingIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { IdentityEmailSchema, InstanceRoleSchema } from "./identity.js";
import { isBareOrigin } from "./origins.js";
import { WorkspaceIconNameSchema } from "./workspace-icons.js";
import { MarkColorSchema } from "./marks.js";

// Keep accepted instants stable across validator upgrades: seconds are optional.
export const IsoDateTimeSchema = z
  .string()
  .regex(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/,
  )
  .meta({ format: "date-time" });

/**
 * An IANA time zone this runtime's `Intl` recognizes, such as
 * "America/New_York". It names where a person is, so a time they say aloud
 * can be turned into an instant.
 */
export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isTimeZone, "Time zone must be an IANA name such as America/New_York");
export type TimeZone = z.infer<typeof TimeZoneSchema>;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const DeploymentLifecycleSchema = z.enum(["active", "transferring", "sealed"]);
export type DeploymentLifecycle = z.infer<typeof DeploymentLifecycleSchema>;

export const RuntimeModeSchema = z.enum(["development", "production"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const WorkspaceBackingKindSchema = z.enum(["local-directory", "portablefs"]);
export type WorkspaceBackingKind = z.infer<typeof WorkspaceBackingKindSchema>;

export const DeploymentKindSchema = z.enum(["personal", "server"]);
export type DeploymentKind = z.infer<typeof DeploymentKindSchema>;

/**
 * `defaultWorkspaceBacking` is the provisioning choice for automatic Main
 * creation and for callers that omit one. It is not an exclusive capability:
 * a Deployment whose default is PortableFS still holds local-directory
 * Workspaces owned by the machines its people lend it.
 */
const deploymentShape = {
  defaultWorkspaceBacking: WorkspaceBackingKindSchema,
  kind: DeploymentKindSchema,
} as const;
export const DeploymentShapeSchema = z.strictObject(deploymentShape);
export const DeploymentShapeViewSchema = z.object(deploymentShape);
export type DeploymentShape = z.infer<typeof DeploymentShapeSchema>;

export function deploymentSupportsSharing(shape: Pick<DeploymentShape, "kind">): boolean {
  return shape.kind === "server";
}

export function localWorkspaceNamespace(
  shape: Pick<DeploymentShape, "kind">,
): "single-owner" | "owner-scoped" {
  return deploymentSupportsSharing(shape) ? "owner-scoped" : "single-owner";
}

/**
 * The Runner a Personal Deployment runs on is the Deployment, not an accessory
 * it can retire: revoking it would leave nothing to run agents on. The store
 * refuses the revocation and the Machines projection reports the same rule as
 * `revocable: false`, so the page and the command path cannot disagree.
 */
export function runnerRunsItsDeployment(input: {
  readonly deploymentIsPersonal: boolean;
  readonly ownerKind: "deployment" | "user";
  readonly runnerKind: "main" | "local" | "managed";
}): boolean {
  return (
    input.deploymentIsPersonal && input.runnerKind === "main" && input.ownerKind === "deployment"
  );
}

export const CanonicalOriginSchema = z
  .url()
  .refine((value) => isBareOrigin(value) && new URL(value).origin === value, {
    message: "Canonical origin must be a normalized, uncredentialed HTTP(S) origin",
  });

export const DeploymentSchema = z.object({
  activeHostInstanceId: HostInstanceIdSchema,
  canonicalOrigin: CanonicalOriginSchema,
  createdAt: IsoDateTimeSchema,
  id: DeploymentIdSchema,
  lifecycle: DeploymentLifecycleSchema,
  updatedAt: IsoDateTimeSchema,
  deploymentShape: DeploymentShapeSchema,
});
export type Deployment = z.infer<typeof DeploymentSchema>;

const UserSchema = z.object({
  createdAt: IsoDateTimeSchema,
  disabledAt: IsoDateTimeSchema.nullable(),
  displayName: z.string().trim().min(1).max(120),
  email: IdentityEmailSchema,
  emailVerified: z.boolean(),
  id: UserIdSchema,
  image: z.url().nullable(),
  instanceRole: InstanceRoleSchema,
  updatedAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

export const WorkspaceStorageIssueSchema = z.object({
  code: z.enum([
    "manager-allocation-rejected",
    "manager-configuration-invalid",
    "manager-identity-rejected",
    "manager-protocol-error",
    "manager-unavailable",
    "manager-unknown-volume-state",
    "local-directory-inaccessible",
    "local-directory-missing",
    "local-directory-replaced",
    "local-registry-invalid",
    // The owning machine is not reachable right now. It is deliberately
    // distinct from the directory codes: connectivity is not evidence about
    // the disk, so this never overwrites a last-verified `ready`.
    "local-authority-unavailable",
    // A Runner answered for this environment while holding another disk.
    "local-authority-mismatch",
  ]),
  message: z.string().trim().min(1).max(500),
  occurredAt: IsoDateTimeSchema,
  retryable: z.boolean(),
});
export type WorkspaceStorageIssue = z.infer<typeof WorkspaceStorageIssueSchema>;

export const WorkspaceKindSchema = z.enum(["main", "specialized"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const PortableFsServiceIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/);

export const WorkspaceBackingSchema = z.discriminatedUnion("kind", [
  // `ownerEnvironmentId` says where the work runs; `storageAuthorityId` proves
  // which disk holds it. They are separate because a Runner credential copied
  // to a second machine reconnects as the same environment, and must not then
  // be able to report the original directory missing or destroy against the
  // wrong disk. Only managed directories exist, so an adopted-folder
  // disposition can be added later as a widening rather than a reinterpretation
  // of what these rows already mean.
  z.strictObject({
    bindingId: WorkspaceBindingIdSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("local-directory"),
    ownerEnvironmentId: EnvironmentIdSchema,
    // Null exists only for local Workspaces created before machines owned
    // their storage. It is an explicit broken binding, never an authority a
    // Runner can claim.
    storageAuthorityId: StorageAuthorityIdSchema.nullable(),
  }),
  z.strictObject({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("portablefs"),
    serviceId: PortableFsServiceIdSchema,
    volumeId: z.string().regex(/^[A-Za-z0-9_-]{1,220}$/),
  }),
]);
export type WorkspaceBacking = z.infer<typeof WorkspaceBackingSchema>;

export type LocalWorkspaceBacking = Extract<WorkspaceBacking, { readonly kind: "local-directory" }>;
export type PortableFsWorkspaceBacking = Extract<WorkspaceBacking, { readonly kind: "portablefs" }>;

export const WorkspaceCapacityPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host-filesystem") }),
  z.strictObject({
    blockHardLimitBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inodeHardLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("hard-quota"),
  }),
]);
export type WorkspaceCapacityPolicy = z.infer<typeof WorkspaceCapacityPolicySchema>;

export const AgentCapabilityProfileIdSchema = z.enum(["main", "workspace", "delegated", "trigger"]);
export type AgentCapabilityProfileId = z.infer<typeof AgentCapabilityProfileIdSchema>;

export const WorkspaceSchema = z
  .object({
    backing: WorkspaceBackingSchema,
    capacityPolicy: WorkspaceCapacityPolicySchema,
    createdAt: IsoDateTimeSchema,
    createdBy: UserIdSchema,
    /** The chosen icon, or null to show the name's initials. */
    icon: WorkspaceIconNameSchema.nullable(),
    /** The colour its mark is drawn in. Older durable Workspace events lack it. */
    color: MarkColorSchema.optional(),
    homeThreadId: ThreadIdSchema.nullable(),
    id: WorkspaceIdSchema,
    kind: WorkspaceKindSchema,
    name: z.string().trim().min(1).max(160),
    status: z.enum([
      "provisioning",
      "ready",
      // `archiving` is the storage authority's archive cycle in flight — the
      // filesystem is neither servable nor sealed yet. It is distinct from
      // `archived`, which promises a sealed archive that can be read and
      // restored from.
      "archiving",
      "archived",
      "unavailable",
      "failed",
      "deleting",
      "deleted",
    ]),
    storageIssue: WorkspaceStorageIssueSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((workspace, context) => {
    const valid =
      (workspace.backing.kind === "local-directory" &&
        workspace.capacityPolicy.kind === "host-filesystem") ||
      (workspace.backing.kind === "portablefs" && workspace.capacityPolicy.kind === "hard-quota");
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Workspace capacity policy does not match its storage backing",
        path: ["capacityPolicy"],
      });
    }
  });
export type Workspace = z.infer<typeof WorkspaceSchema>;

/**
 * Statuses whose storage is out of service but recoverable on demand: a wake
 * at the storage authority brings the filesystem back, cancelling an archive
 * cycle that is still quiescing if one is in flight. Demand paths must ask for
 * the wake and retry rather than reporting a failure.
 */
export const wakeableWorkspaceStatuses = [
  "archiving",
  "archived",
] as const satisfies readonly Workspace["status"][];

export function workspaceWakesOnDemand(status: Workspace["status"]): boolean {
  return (wakeableWorkspaceStatuses as readonly string[]).includes(status);
}

// The wire contract stays limited to the capabilities every Runner actually advertises.
export const RunnerCapabilitySchema = z.enum([
  "assignments-v1",
  // Runs a successor attempt of a Run from the Host's next ordinal, and stops
  // exactly the execution an interrupt names.
  "attempts-v1",
  "earlier-boots-contained-v1",
  // Accepts a `browser-page` content part in a Run's inputs; an older Runner's
  // strict input schema refuses the whole Run.
  "browser-page-input-v1",
  // Its engines expect the current agent tool catalog: browser_profile_create, and
  // neither browser_profile_save nor browser_sign_in, which the Host serves only to Runners
  // without this.
  "browser-profile-create-v1",
  "environment-list-v1",
  // Can parse and execute v3 Trigger and Watch programs; independent of tool discovery.
  "trigger-program-v3",
  "native-place-input-v1",
  "execution-plane-v2",
  "filesystem",
  "model-server-discovery-v1",
  "voice-v1",
  // Runs a voice call's own agent, which acts through the calling device.
  "voice-agent-v1",
  "network-egress",
  "native-session-continuation-v1",
  // Carries `requesterTimeZone` in every Run's context.
  "requester-time-zone-v1",
  // A message steered into a Run and accepted by its engine is answered in that
  // Run, as a turn of its own if the engine was already answering.
  "steer-answer-v1",
  "thread-state-v1",
  // Names a Thread from a Run's `titleRequest` with that Run's engine and
  // account, and reports it with `runner.thread-title`.
  "thread-title-v1",
  // Also picks the Thread's symbol when its `titleRequest` asks with `icon`,
  // and reports it on `runner.thread-title`.
  "thread-icon-v1",
  "task-done-v1",
]);
export type RunnerCapability = z.infer<typeof RunnerCapabilitySchema>;

export const ExecutionEnvironmentKindSchema = z.enum(["main", "local", "managed"]);
export type ExecutionEnvironmentKind = z.infer<typeof ExecutionEnvironmentKindSchema>;

export const HarnessIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(100)
  .brand<"HarnessId">();
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** Where one configured harness instance keeps its provider-owned account state. */
export const HarnessInstanceStateKindSchema = z.enum(["ambient", "isolated"]);
export type HarnessInstanceStateKind = z.infer<typeof HarnessInstanceStateKindSchema>;

/**
 * Monotonic fence for the runtime-affecting definition of a harness instance.
 * Presentation-only changes such as renaming an instance do not change it. The
 * bound is the durable column's, so a value that survives a round trip through
 * the Host's record is exactly a value this schema accepts.
 */
export const HarnessRuntimeRevisionSchema = z.number().int().positive().max(2_147_483_647);
export type HarnessRuntimeRevision = z.infer<typeof HarnessRuntimeRevisionSchema>;

/**
 * A model provider is independent from the harness that drives it. For
 * example, a Codex-compatible harness may expose OpenAI, Azure, or an
 * operator-defined provider. Never infer this value from `driverKind`.
 */
export const ModelProviderIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(100)
  .brand<"ModelProviderId">();
export const ModelIdSchema = z.string().trim().min(1).max(255).brand<"ModelId">();

export const ModelOptionValueSchema = z.union([
  z.string().max(255),
  z.number().finite(),
  z.boolean(),
]);

const modelSelectionShape = {
  modelId: ModelIdSchema,
  /**
   * The id the account's endpoint answers to, when it differs from modelId.
   * The Host copies it from the catalog descriptor the selection matched and
   * never accepts it from a client; a Run sends it verbatim while the
   * canonical (providerId, modelId) pair stays the grouping key.
   */
  nativeModelId: z.string().min(1).max(255).optional(),
  options: z
    .record(
      z
        .string()
        .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
        .max(100),
      ModelOptionValueSchema,
    )
    .refine(
      (options) => Object.keys(options).length <= 16,
      "A model selection has too many options",
    ),
  providerId: ModelProviderIdSchema,
} as const;
export const ModelSelectionSchema = z.strictObject(modelSelectionShape);
export const ModelSelectionViewSchema = z.object(modelSelectionShape);
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/**
 * A model named for new delegated work: the canonical pair and the options the
 * caller wants, admitted against the running account's live catalog. The id an
 * endpoint answers to is the Host's to copy from that catalog, never a caller's.
 */
export const DelegationModelChoiceSchema = z.strictObject({
  modelId: ModelIdSchema,
  options: modelSelectionShape.options.default({}),
  providerId: ModelProviderIdSchema,
});
export type DelegationModelChoice = z.infer<typeof DelegationModelChoiceSchema>;

/**
 * Identifies the native provider state store that can resume a Thread.
 * Different harness instances are continuation-compatible only when both
 * fields match exactly. Harness drivers may derive the key from private local
 * state, but the Runner must replace it with its stable signed opaque
 * projection before the identity crosses the Runner boundary.
 */
const providerContinuationIdentityShape = {
  continuationKey: z.string().regex(/^runner:v1:[A-Za-z0-9_-]{43}$/),
  driverKind: HarnessIdSchema,
} as const;
export const ProviderContinuationIdentitySchema = z.strictObject(providerContinuationIdentityShape);
export const ProviderContinuationIdentityViewSchema = z.object(providerContinuationIdentityShape);
export type ProviderContinuationIdentity = z.infer<typeof ProviderContinuationIdentitySchema>;

export function sameProviderContinuationIdentity(
  left: ProviderContinuationIdentity,
  right: ProviderContinuationIdentity,
): boolean {
  return left.driverKind === right.driverKind && left.continuationKey === right.continuationKey;
}

export const ThreadStatusSchema = z.enum(["idle", "running", "waiting", "failed", "archived"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export const ThreadRoleSchema = z.enum(["conversation", "work"]);
export type ThreadRole = z.infer<typeof ThreadRoleSchema>;

/**
 * Provider-neutral control over how an agent may act during a Run. Harnesses
 * must translate every mode explicitly; provider defaults are never the
 * authority for an Opensteer Thread.
 */
export const ThreadAccessModeSchema = z.enum([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type ThreadAccessMode = z.infer<typeof ThreadAccessModeSchema>;
export function threadAccessModeAtMost(mode: ThreadAccessMode, ceiling: ThreadAccessMode): boolean {
  return (
    ThreadAccessModeSchema.options.indexOf(mode) <= ThreadAccessModeSchema.options.indexOf(ceiling)
  );
}
export const DEFAULT_THREAD_ACCESS_MODE: ThreadAccessMode = "full-access";
/**
 * The title of a person's Chat, the Thread `Workspace.homeThreadId` names. The
 * Host sets it on creation whatever a client sends, so an older client cannot
 * bring back an earlier name.
 */
export const CHAT_THREAD_TITLE = "Chat";

export const ThreadSchema = z.object({
  accessMode: ThreadAccessModeSchema,
  capabilityProfileId: AgentCapabilityProfileIdSchema,
  continuationIdentity: ProviderContinuationIdentitySchema.nullable(),
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  /**
   * When someone marked this task Done, which stopped it and the work it handed
   * out; null while it is open. A Done task takes no new work until someone
   * reopens it. Older durable Thread events carry no such field.
   */
  doneAt: IsoDateTimeSchema.nullable().default(null),
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  id: ThreadIdSchema,
  lineageRootThreadId: ThreadIdSchema,
  inputQueuePaused: z.boolean(),
  /**
   * Whether the Thread is one of its person's tasks in navigation lists: a root
   * Thread, or work a conversation such as Home handed off. Work that a task
   * delegates is reached through that task instead. The Host decides this once,
   * at creation, from the parent's role; `parentThreadId` remains lineage only.
   */
  listed: z.boolean(),
  modelSelection: ModelSelectionSchema,
  parentThreadId: ThreadIdSchema.nullable(),
  pendingRequests: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  role: ThreadRoleSchema,
  // Older durable Thread events did not record which native session was selected.
  providerSessionId: ProviderSessionIdSchema.nullable().default(null),
  status: ThreadStatusSchema,
  title: z.string().trim().min(1).max(240),
  /**
   * What the task is about, as a symbol; null until it is decided (its engine
   * names it with its title) and for Chat. A settled "nothing specific" is
   * `defaultTaskSymbol`. Older durable Thread events carry neither field.
   */
  icon: WorkspaceIconNameSchema.nullable().default(null),
  /** The task's own colour, fixed at creation; see `MarkColorSchema`. */
  color: MarkColorSchema.optional(),
  updatedAt: IsoDateTimeSchema,
  workspaceId: WorkspaceIdSchema,
});
export const ThreadViewSchema = z.object({
  ...ThreadSchema.shape,
  // A colour a newer Host added reads as none rather than failing the view.
  color: MarkColorSchema.optional().catch(undefined),
  continuationIdentity: ProviderContinuationIdentityViewSchema.nullable(),
  modelSelection: ModelSelectionViewSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;

/** Display-only epoch-48 projection; current clients use the Thread's doneAt. */
export const TaskPlacementSchema = z.object({
  done: z.boolean(),
  sequence: SequenceSchema,
});
export type TaskPlacement = z.infer<typeof TaskPlacementSchema>;

export const ThreadReadStateSchema = z.object({
  threadId: ThreadIdSchema,
  readSequence: SequenceSchema.nullable(),
  unreadSequence: SequenceSchema.nullable(),
  // Optional for current readers; every Host producer supplies both fields.
  placement: TaskPlacementSchema.nullable().optional(),
  placementRevision: SequenceSchema.optional(),
  asOfSequence: SequenceSchema,
});
export type ThreadReadState = z.infer<typeof ThreadReadStateSchema>;

export const WorkspaceNotificationPreferenceSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  muted: z.boolean(),
  revision: SequenceSchema,
});
export type WorkspaceNotificationPreference = z.infer<typeof WorkspaceNotificationPreferenceSchema>;

const messageContentMaxParts = 64;
export const messageContentMaxSerializedBytes = 350 * 1_024;
/** The most UTF-16 units one text part of a message may hold. */
export const messageTextPartMaxLength = 256 * 1_024;

export const BrowserPageContentPartSchema = z.object({
  type: z.literal("browser-page"),
  /** The draft picked this page up by itself rather than the person choosing it. */
  auto: z.boolean().optional(),
  /** The exact document the page showed when it was included. */
  documentId: z.string().min(1).max(255).optional(),
  sessionId: BrowserSessionIdSchema,
  tabId: BrowserSurfaceIdSchema,
  title: z.string().max(256),
  url: z.string().max(2048),
});
export const ComputerAppContentPartSchema = z.object({
  type: z.literal("computer-app"),
  machineId: RunnerIdSchema,
  app: ComputerAppIdentityViewSchema,
  name: z.string().min(1).max(255),
  auto: z.literal(false).optional(),
});
export const PhoneContentPartSchema = z.object({
  type: z.literal("phone"),
  machineId: RunnerIdSchema,
  display: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  auto: z.literal(false).optional(),
});
export const PlaceContentPartSchema = z.discriminatedUnion("type", [
  BrowserPageContentPartSchema,
  ComputerAppContentPartSchema,
  PhoneContentPartSchema,
]);
export type PlaceContentPart = z.infer<typeof PlaceContentPartSchema>;
export const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(messageTextPartMaxLength) }),
  BrowserPageContentPartSchema,
  ComputerAppContentPartSchema,
  PhoneContentPartSchema,
  z.object({
    type: z.literal("artifact"),
    artifactId: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(255),
    name: z.string().min(1).max(1_024),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;
export function isPlaceContentPart(part: ContentPart): part is PlaceContentPart {
  return part.type === "browser-page" || part.type === "computer-app" || part.type === "phone";
}

/** The signed Runner advertisement is the boundary for new message part kinds. */
export function placeInputFailure(
  content: readonly ContentPart[],
  capabilities: readonly string[],
): string | null {
  if (
    content.some((part) => part.type === "browser-page") &&
    !capabilities.includes("browser-page-input-v1")
  ) {
    return "Update this Runner so agents can read the browser pages people include with messages.";
  }
  if (
    content.some((part) => part.type === "computer-app" || part.type === "phone") &&
    !capabilities.includes("native-place-input-v1")
  ) {
    return "Update this Runner so agents can read the apps and phones people include with messages.";
  }
  return null;
}

/** Display text for a reference; summaries must never fall back to its address. */
export function placeContentLabel(part: PlaceContentPart): string {
  switch (part.type) {
    case "browser-page":
      return part.title || "Browser page";
    case "computer-app":
      return part.name;
    case "phone":
      return part.name;
  }
}

/**
 * Whether message content says something: a file, a page, or text that is not blank.
 * A message that says nothing is not shown, and is never a Run's reply.
 */
export function contentSaysSomething(
  content: ReadonlyArray<{ readonly type: string; readonly text?: unknown }>,
): boolean {
  return content.some(
    (part) =>
      part.type === "artifact" ||
      part.type === "browser-page" ||
      part.type === "computer-app" ||
      part.type === "phone" ||
      (part.type === "text" && typeof part.text === "string" && part.text.trim() !== ""),
  );
}
export type ArtifactContentPart = Extract<ContentPart, { readonly type: "artifact" }>;
export type ComputerAppContentPart = Extract<ContentPart, { readonly type: "computer-app" }>;
export type PhoneContentPart = Extract<ContentPart, { readonly type: "phone" }>;
export type BrowserPageContentPart = Extract<ContentPart, { readonly type: "browser-page" }>;

export const MessageContentSchema = z
  .array(ContentPartSchema)
  .min(1)
  .max(messageContentMaxParts)
  .refine(
    (content) =>
      new TextEncoder().encode(JSON.stringify(content)).byteLength <=
      messageContentMaxSerializedBytes,
    `Message content must not exceed ${messageContentMaxSerializedBytes} serialized bytes`,
  );

export const MessageKindSchema = z.enum(["input", "assistant", "run-result", "continuation"]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const TriggerOccurrenceSourceKindSchema = z.enum(["manual", "schedule", "webhook", "watch"]);

const messageAuthorVariants = [
  z.strictObject({
    displayName: z.string().trim().min(1).max(160),
    kind: z.literal("human"),
    principalId: z.string().trim().min(1).max(255),
    userId: UserIdSchema.optional(),
  }),
  z.strictObject({
    displayName: z.string().trim().min(1).max(240),
    kind: z.literal("agent"),
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
    workspaceName: z.string().trim().min(1).max(160),
  }),
  z.strictObject({
    displayName: z.string().trim().min(1).max(160),
    kind: z.literal("trigger"),
    occurrenceId: TriggerOccurrenceIdSchema,
    source: TriggerOccurrenceSourceKindSchema,
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    activationId: TriggerWatchActivationIdSchema,
    displayName: z.string().trim().min(1).max(160),
    kind: z.literal("watch"),
    revisionId: TriggerRevisionIdSchema,
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    cause: z.string().trim().min(1).max(120),
    kind: z.literal("platform"),
    referenceId: z.string().trim().min(1).max(255).optional(),
  }),
] as const;
export const MessageAuthorSchema = z.discriminatedUnion("kind", messageAuthorVariants);
export const MessageAuthorViewSchema = z.discriminatedUnion("kind", [
  z.object(messageAuthorVariants[0].shape),
  z.object(messageAuthorVariants[1].shape),
  z.object(messageAuthorVariants[2].shape),
  z.object(messageAuthorVariants[3].shape),
  z.object(messageAuthorVariants[4].shape),
]);
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

/** Host-resolved attribution for an earlier message explicitly quoted by a person. */
export const MessageQuoteSchema = z.object({
  messageId: MessageIdSchema,
  threadId: ThreadIdSchema,
  author: MessageAuthorSchema,
  excerpt: z.string().max(4000),
});
export const MessageQuoteViewSchema = z.object({
  ...MessageQuoteSchema.shape,
  author: MessageAuthorViewSchema,
});
export type MessageQuote = z.infer<typeof MessageQuoteSchema>;

/** The single canonical compatibility rule between durable message kind and author. */
export function messageAuthorCanWriteKind(
  author: Pick<MessageAuthor, "kind">,
  kind: MessageKind,
): boolean {
  return (
    (kind === "input" && author.kind !== "platform") ||
    ((kind === "assistant" || kind === "run-result") && author.kind === "agent") ||
    (kind === "continuation" && author.kind === "platform")
  );
}

const replyTargetShape = {
  conversationId: z.string().trim().min(1).max(255),
  kind: z.literal("channel"),
} as const;
export const ReplyTargetSchema = z.strictObject(replyTargetShape);
export const ReplyTargetViewSchema = z.object(replyTargetShape);
export type ReplyTarget = z.infer<typeof ReplyTargetSchema>;

const messageShape = {
  author: MessageAuthorSchema,
  content: MessageContentSchema,
  createdAt: IsoDateTimeSchema,
  id: MessageIdSchema,
  kind: MessageKindSchema,
  quote: MessageQuoteSchema.optional(),
  runId: RunIdSchema.nullable(),
  sequence: SequenceSchema,
  threadId: ThreadIdSchema,
} as const;

function validateMessage(
  message: { readonly author: MessageAuthor; readonly kind: MessageKind },
  context: z.RefinementCtx,
): void {
  if (!messageAuthorCanWriteKind(message.author, message.kind)) {
    context.addIssue({
      code: "custom",
      message: `Message kind ${message.kind} cannot be authored by ${message.author.kind}`,
      path: ["author"],
    });
  }
}

export const ThreadInputPolicySchema = z.enum(["report", "queue", "steer"]);
export type ThreadInputPolicy = z.infer<typeof ThreadInputPolicySchema>;

export const MessageSchema = z.strictObject(messageShape).superRefine(validateMessage);
export const MessageViewSchema = z
  .object({
    ...messageShape,
    author: MessageAuthorViewSchema,
    /**
     * How an input was delivered, where a read has its Thread input at hand.
     * Runners never receive it: their Message contract stays strict.
     */
    policy: ThreadInputPolicySchema.optional(),
    /** Whether this read's input has reached the published conversation. */
    published: z.boolean().optional(),
    quote: MessageQuoteViewSchema.optional(),
  })
  .superRefine(validateMessage);
export type Message = z.infer<typeof MessageSchema>;
export type MessageView = z.infer<typeof MessageViewSchema>;

export const ThreadInputStateSchema = z.enum([
  "pending",
  "claimed",
  "delivered",
  "unknown",
  "cancelled",
]);
export type ThreadInputState = z.infer<typeof ThreadInputStateSchema>;

const threadInputShape = {
  assignmentId: AssignmentIdSchema.nullable(),
  cancelReason: z.string().max(500).nullable(),
  causalChainId: CausalChainIdSchema,
  createdAt: IsoDateTimeSchema,
  deliveredAt: IsoDateTimeSchema.nullable(),
  messageId: MessageIdSchema,
  policy: ThreadInputPolicySchema,
  replyTarget: ReplyTargetSchema.nullable(),
  runId: RunIdSchema.nullable(),
  state: ThreadInputStateSchema,
  threadId: ThreadIdSchema,
  updatedAt: IsoDateTimeSchema,
} as const;
export const ThreadInputSchema = z.strictObject(threadInputShape);
export const ThreadInputViewSchema = z.object({
  ...threadInputShape,
  replyTarget: ReplyTargetViewSchema.nullable(),
});
export type ThreadInput = z.infer<typeof ThreadInputSchema>;

/** A report is published while waiting; queued and steered work must be received. */
export function threadInputIsPublished(input: Pick<ThreadInput, "policy" | "state">): boolean {
  return input.state === "delivered" || (input.policy === "report" && input.state !== "cancelled");
}

/**
 * The messages waiting behind a Thread's current work: queued inputs that no
 * Run has picked up yet, in the order the next Run takes them. A message that
 * already seeds a Run, or that a promotion has handed to one, belongs to the
 * transcript, not here. Steering, cancelling and moving act on the same
 * durable message; the Host says per item which of them it will accept from
 * the reader.
 */
export const ThreadInputQueueViewSchema = z.object({
  threadId: ThreadIdSchema,
  paused: z.boolean(),
  steerRunId: RunIdSchema.nullable(),
  items: z
    .array(
      z.object({
        message: MessageViewSchema,
        input: ThreadInputViewSchema,
        canCancel: z.boolean(),
        canMove: z.boolean(),
        canSteer: z.boolean(),
      }),
    )
    .max(100),
});
export type ThreadInputQueue = z.infer<typeof ThreadInputQueueViewSchema>;

/**
 * The one rule for rearranging a queue: `moving` stands immediately in front
 * of `before`, or at the back when `before` is null, and everything else keeps
 * its order. In front of itself is where it already stands.
 */
export function moveQueueItem<Item>(
  items: readonly Item[],
  moving: Item,
  before: Item | null,
): Item[] {
  const rest = items.filter((item) => item !== moving);
  rest.splice(
    before === moving
      ? items.indexOf(moving)
      : before === null
        ? rest.length
        : rest.indexOf(before),
    0,
    moving,
  );
  return rest;
}

export const causalChainMaxAutonomousRuns = 64;
export const causalChainMaxDelegations = 32;
export const agentDelegationMaxDepth = 4;
export const threadInputMaxPendingEntries = 100;
export const threadInputMaxPendingSerializedBytes = 4 * 1_024 * 1_024;
export const threadReportMaxPendingEntries = 1_000;
export const threadReportMaxPendingSerializedBytes = 32 * 1_024 * 1_024;
export const threadReportBatchMaxEntries = 50;
// Larger than the largest legal Message content plus its bounded author and
// receipt metadata, so every individual report can fit an otherwise empty batch.
export const threadReportBatchMaxSerializedBytes = 512 * 1_024;

export const RunStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
]);
type RunStatus = z.infer<typeof RunStatusSchema>;

export const nonTerminalRunStatuses = [
  "queued",
  "starting",
  "running",
  "waiting",
] as const satisfies readonly RunStatus[];
export const ActiveRunStatusSchema = z.enum(nonTerminalRunStatuses);

/**
 * The Run failure code a harness reports when the account behind the engine
 * has no capacity left rather than the work being wrong. The web offers a
 * switch to a compatible account on it, so the code is shared rather than
 * spelled out at each end.
 */
export const harnessUsageLimitFailureCode = "harness_usage_limit";

/** The longest a Run's failure message may be, in UTF-16 units. */
export const runFailureMessageMaxLength = 20_000;

const runFailureShape = {
  code: z.string().min(1).max(255),
  message: z.string().max(runFailureMessageMaxLength),
  retryable: z.boolean(),
  status: z.literal("failed"),
} as const;
export const RunFailureSchema = z.strictObject(runFailureShape);
export const RunFailureViewSchema = z.object(runFailureShape);
export type RunFailure = z.infer<typeof RunFailureSchema>;

/**
 * What one Run consumed, as the provider reported it. Opensteer never
 * estimates: a field is present only when the engine stated it, and `costUsd`
 * is the provider's own number.
 *
 * The counts mean the same for every engine, whatever its provider's own
 * split. `inputTokens` is input read neither from nor into the prompt cache:
 * cache reads are `cachedInputTokens` and cache writes `cacheWriteTokens`, so
 * a driver whose provider counts them inside its input subtracts them.
 * `outputTokens` includes reasoning, and `reasoningTokens` is the part of it
 * spent reasoning.
 *
 * Token counts are bounded to the safe integer range because that is what
 * their bigint columns and JSON both carry, and `costUsd` to what its
 * `numeric(18, 8)` column holds.
 */
const runUsageShape = {
  cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  cacheWriteTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  costUsd: z.number().nonnegative().max(1_000_000_000).optional(),
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reasoningTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
} as const;
export const RunUsageSchema = z.strictObject(runUsageShape);
export const RunUsageViewSchema = z.object(runUsageShape);
export type RunUsage = z.infer<typeof RunUsageSchema>;

const runShape = {
  accessMode: ThreadAccessModeSchema,
  activationInputId: MessageIdSchema,
  assignmentId: AssignmentIdSchema.nullable(),
  causalChainId: CausalChainIdSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  environmentId: EnvironmentIdSchema,
  failure: RunFailureSchema.nullable(),
  harnessInstanceId: HarnessInstanceIdSchema,
  id: RunIdSchema,
  modelSelection: ModelSelectionSchema,
  replyTarget: ReplyTargetSchema.nullable(),
  providerSessionId: ProviderSessionIdSchema.nullable(),
  requestedBy: UserIdSchema,
  runOrdinal: z.number().int().nonnegative(),
  startedAt: IsoDateTimeSchema.nullable(),
  status: RunStatusSchema,
  threadId: ThreadIdSchema,
  seedInputId: MessageIdSchema,
  usage: RunUsageSchema.optional(),
} as const;
export const RunSchema = z.strictObject(runShape);
export const RunViewSchema = z.object({
  ...runShape,
  failure: RunFailureViewSchema.nullable(),
  modelSelection: ModelSelectionViewSchema,
  usage: RunUsageViewSchema.optional(),
  replyTarget: ReplyTargetViewSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * One execution of a Run. Steering restarts and execution recovery create successors;
 * each records where and with what it ran, how it ended, and what it consumed.
 * The Run's usage is the sum over its attempts.
 */
const runAttemptShape = {
  createdAt: IsoDateTimeSchema,
  /** When it was sent to a Runner; null for a replacement that never was. */
  dispatchedAt: IsoDateTimeSchema.nullable(),
  /**
   * Whether its engine was already running for the Thread (`warm`) or started
   * for it (`cold`); null until the Runner reports it.
   */
  engineStart: z.enum(["cold", "warm"]).nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  id: RunAttemptIdSchema,
  modelSelection: ModelSelectionSchema.nullable(),
  ordinal: z.number().int().min(1),
  outcome: z.enum(["completed", "failed", "interrupted", "cancelled"]).nullable(),
  reason: z.enum(["initial", "steer_restart", "recovery"]),
  runId: RunIdSchema,
  runnerId: RunnerIdSchema.nullable(),
  /** When its engine accepted the work. */
  startedAt: IsoDateTimeSchema.nullable(),
  status: z.enum(["current", "superseded"]),
  usage: RunUsageSchema.nullable(),
} as const;
export const RunAttemptSchema = z.strictObject(runAttemptShape);
export const RunAttemptViewSchema = z.object({
  ...runAttemptShape,
  modelSelection: ModelSelectionViewSchema.nullable(),
  usage: RunUsageViewSchema.nullable(),
});
export type RunAttempt = z.infer<typeof RunAttemptSchema>;

/** One subagent a Run's engine started, as the Host recorded it. */
const executionNodeShape = {
  attemptId: RunAttemptIdSchema,
  endedAt: IsoDateTimeSchema.nullable(),
  id: ExecutionNodeIdSchema,
  kind: z.enum(["subagent", "task"]),
  model: z.string().min(1).max(255).nullable(),
  parentNodeId: ExecutionNodeIdSchema.nullable(),
  prompt: z
    .string()
    .max(8 * 1_024)
    .nullable(),
  result: z
    .string()
    .max(16 * 1_024)
    .nullable(),
  runId: RunIdSchema,
  startedAt: IsoDateTimeSchema,
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  title: z.string().min(1).max(240),
  /** Its own share, which the Run's usage already includes. */
  usage: RunUsageSchema.nullable(),
} as const;
export const ExecutionNodeSchema = z.strictObject(executionNodeShape);
export const ExecutionNodeViewSchema = z.object({
  ...executionNodeShape,
  usage: RunUsageViewSchema.nullable(),
});
export type ExecutionNode = z.infer<typeof ExecutionNodeSchema>;

/**
 * How long a Run's background work may keep it live after its engine's turn
 * ended. Counted once per Run, from the first time it went to the background,
 * so neither a reconnect nor a Host restart extends it.
 */
export const runBackgroundMaxMs = 4 * 60 * 60 * 1_000;

export const AssignmentOriginSchema = z.enum(["run", "trigger", "watch"]);
export type AssignmentOrigin = z.infer<typeof AssignmentOriginSchema>;
export const AssignmentStatusSchema = z.enum(["open", "completed", "failed", "cancelled"]);
export type AssignmentStatus = z.infer<typeof AssignmentStatusSchema>;
export const AssignmentReturnStatusSchema = z.enum(["pending", "delivered", "undeliverable"]);
export type AssignmentReturnStatus = z.infer<typeof AssignmentReturnStatusSchema>;
export const assignmentObjectiveMaxBytes = 2 * 1_024;
export const assignmentResultMaxBytes = 64 * 1_024;

const assignmentShape = {
  createdAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  id: AssignmentIdSchema,
  initialInputMessageId: MessageIdSchema,
  initialRunId: RunIdSchema,
  objective: z.string().trim().min(1).max(assignmentObjectiveMaxBytes),
  origin: AssignmentOriginSchema,
  parentAssignmentId: AssignmentIdSchema.nullable(),
  parentOccurrenceId: TriggerOccurrenceIdSchema.nullable(),
  parentRunId: RunIdSchema.nullable(),
  parentThreadId: ThreadIdSchema,
  parentWatchActivationId: TriggerWatchActivationIdSchema.nullable(),
  replyTarget: ReplyTargetSchema.nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  resultRunId: RunIdSchema.nullable(),
  resultText: z.string().max(assignmentResultMaxBytes).nullable(),
  returnAttemptedAt: IsoDateTimeSchema.nullable(),
  returnMessageId: MessageIdSchema.nullable(),
  returnReason: z.string().trim().min(1).max(500).nullable(),
  returnStatus: AssignmentReturnStatusSchema,
  status: AssignmentStatusSchema,
  updatedAt: IsoDateTimeSchema,
  workerThreadId: ThreadIdSchema,
} as const;

export const AssignmentSchema = z
  .strictObject(assignmentShape)
  .superRefine((assignment, context) => {
    const origin =
      assignment.parentRunId !== null
        ? "run"
        : assignment.parentOccurrenceId !== null
          ? "trigger"
          : "watch";
    const parents =
      Number(assignment.parentRunId !== null) +
      Number(assignment.parentOccurrenceId !== null) +
      Number(assignment.parentWatchActivationId !== null);
    if (parents !== 1 || origin !== assignment.origin) {
      context.addIssue({
        code: "custom",
        message: "Assignment origin and return address disagree",
      });
    }
    const terminal = assignment.status !== "open";
    if (terminal !== (assignment.finishedAt !== null)) {
      context.addIssue({ code: "custom", message: "Assignment terminal time is inconsistent" });
    }
    if (
      assignment.status === "open" &&
      (assignment.resultText !== null || assignment.resultRunId !== null)
    ) {
      context.addIssue({ code: "custom", message: "Open Assignment cannot have a result" });
    }
    if (
      (assignment.status === "completed" || assignment.status === "failed") &&
      (assignment.resultText === null || assignment.resultRunId === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Finished Assignment must have an exact result",
      });
    }
    if (assignment.returnStatus === "delivered" && assignment.returnMessageId === null) {
      context.addIssue({
        code: "custom",
        message: "Delivered Assignment must have a return receipt",
      });
    }
    if (assignment.returnStatus === "undeliverable" && assignment.returnReason === null) {
      context.addIssue({ code: "custom", message: "Undeliverable Assignment must have a reason" });
    }
  });
export const AssignmentViewSchema = z.object({
  ...assignmentShape,
  replyTarget: ReplyTargetViewSchema.nullable(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
export type AssignmentView = z.infer<typeof AssignmentViewSchema>;

export const AssignmentSummarySchema = z.object({
  createdAt: IsoDateTimeSchema,
  currentRunId: RunIdSchema.nullable(),
  currentRunStatus: RunStatusSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  id: AssignmentIdSchema,
  initialRunId: RunIdSchema,
  modelLabel: ModelIdSchema.nullable(),
  objectivePreview: z.string().max(assignmentObjectiveMaxBytes),
  origin: AssignmentOriginSchema,
  parentThreadId: ThreadIdSchema,
  resultPreview: z
    .string()
    .max(8 * 1_024)
    .nullable(),
  returnStatus: AssignmentReturnStatusSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: AssignmentStatusSchema,
  updatedAt: IsoDateTimeSchema,
  workerThread: z.object({
    environmentId: EnvironmentIdSchema,
    id: ThreadIdSchema,
    pendingRequests: z.number().int().nonnegative(),
    status: ThreadStatusSchema,
    title: z.string().trim().min(1).max(240),
    /** The worker's mark, as on `Thread`; absent from summaries written before marks. */
    icon: WorkspaceIconNameSchema.nullable().default(null),
    color: MarkColorSchema.optional().catch(undefined),
    workspaceId: WorkspaceIdSchema,
  }),
});
export type AssignmentSummary = z.infer<typeof AssignmentSummarySchema>;

export const AssignmentRunContextSchema = z.object({
  id: AssignmentIdSchema,
  objective: z.string().trim().min(1).max(assignmentObjectiveMaxBytes),
  origin: AssignmentOriginSchema,
  parentThreadId: ThreadIdSchema,
});
export type AssignmentRunContext = z.infer<typeof AssignmentRunContextSchema>;

/** A failure is quoted to the next Run so it can be read; its full text stays on the Run. */
export const runThreadStateFailureMaxChars = 300;

/**
 * What the Host knew about a Thread when it dispatched a Run and the engine's
 * own history cannot show: a previous Run that did not complete, and how the
 * Thread's previous task ended. Facts only; the agent decides what they mean.
 */
export const RunThreadStateSchema = z.strictObject({
  previousAssignment: z
    .strictObject({
      finishedAt: IsoDateTimeSchema,
      id: AssignmentIdSchema,
      origin: AssignmentOriginSchema,
      /** Null when the requester can no longer read the Thread it answers to. */
      parentThreadId: ThreadIdSchema.nullable(),
      returnStatus: AssignmentReturnStatusSchema,
      status: AssignmentStatusSchema.exclude(["open"]),
    })
    .nullable(),
  previousRun: z
    .strictObject({
      endedAt: IsoDateTimeSchema,
      failure: z
        .strictObject({
          code: z.string().min(1).max(255),
          message: z.string().max(runThreadStateFailureMaxChars),
        })
        .nullable(),
      seedMessageId: MessageIdSchema,
      status: z.enum(["failed", "interrupted"]),
    })
    .nullable(),
});
export type RunThreadState = z.infer<typeof RunThreadStateSchema>;

/**
 * The compact, ordered read model used to project a Thread's non-terminal
 * Runs. Queue ownership belongs to the Host; harnesses only receive the head
 * entry after every lower ordinal is terminal.
 */
export const ThreadRunQueueEntrySchema = RunSchema.pick({
  createdAt: true,
  id: true,
  status: true,
  threadId: true,
  runOrdinal: true,
})
  .extend({ status: ActiveRunStatusSchema })
  .strict();
export const ThreadRunQueueEntryViewSchema = z.object(ThreadRunQueueEntrySchema.shape);
export type ThreadRunQueueEntry = z.infer<typeof ThreadRunQueueEntrySchema>;

export const ExecutionBindingStatusSchema = z.enum([
  "starting",
  "ready",
  "running",
  "stopped",
  "broken",
]);

export const ThreadExecutionBindingSchema = z.object({
  bindingGeneration: z.number().int().positive(),
  createdAt: IsoDateTimeSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  leaseExpiresAt: IsoDateTimeSchema,
  providerSessionId: ProviderSessionIdSchema,
  providerSessionReference: z.string().min(1).max(2048).nullable(),
  runnerBootId: z.string().min(1).max(255),
  runnerId: RunnerIdSchema,
  status: ExecutionBindingStatusSchema,
  threadId: ThreadIdSchema,
});
export type ThreadExecutionBinding = z.infer<typeof ThreadExecutionBindingSchema>;
