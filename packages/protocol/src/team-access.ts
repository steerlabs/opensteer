import { CanSchema, LevelSchema, TeamReasonSchema, RunnerIdSchema } from "@opensteer/core";
export { CanSchema, LevelSchema, TeamReasonSchema } from "@opensteer/core";
import { z } from "zod";
import {
  CommandIdSchema,
  DeploymentIdSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  MarkColorSchema,
  ModelSelectionSchema,
  ModelSelectionViewSchema,
  ThreadAccessModeSchema,
  TimeZoneSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  utf8ByteLength,
  idSchema,
} from "@opensteer/core";
import { IdentityConfigViewSchema } from "./bootstrap.js";
import { AgentConnectionIdSchema } from "./agent-connections.js";

export const RevisionSchema = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const uuid = z.uuid().toLowerCase();
const name = z.string().trim().min(1).max(120);
const timestamp = z.iso.datetime({ offset: true });
const cursor = z.string().min(1).max(2048);
const query = z.string().max(120);
const connectionId = AgentConnectionIdSchema;
export const PageSchema = z.strictObject({
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const MemberKindSchema = z.enum(["full", "guest"]);
export const MemberStateSchema = z.enum(["active", "suspended", "removed"]);
export const SubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("group"), groupId: uuid }),
]);
export const ProjectTargetSchema = z.strictObject({
  kind: z.literal("project"),
  workspaceId: WorkspaceIdSchema,
});
export const MutationBaseSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(255),
  expectedRevision: RevisionSchema,
});
export const AccessChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create-group"), id: uuid, name }),
  z.strictObject({ kind: z.literal("rename-group"), groupId: uuid, name }),
  z.strictObject({ kind: z.literal("delete-group"), groupId: uuid }),
  z.strictObject({
    kind: z.literal("add-group-member"),
    groupId: uuid,
    member: SubjectSchema,
  }),
  z.strictObject({
    kind: z.literal("remove-group-member"),
    groupId: uuid,
    member: SubjectSchema,
  }),
  z.strictObject({
    kind: z.literal("grant"),
    id: uuid,
    subject: SubjectSchema,
    target: ProjectTargetSchema,
    level: LevelSchema,
  }),
  z.strictObject({ kind: z.literal("revoke"), entryId: uuid }),
]);
export const AccessChangesSchema = z
  .array(AccessChangeSchema)
  .min(1)
  .max(100)
  .refine(
    (changes) => new Set(changes.map((change) => JSON.stringify(change))).size === changes.length,
    "An access batch cannot contain duplicate changes",
  )
  .refine((changes) => {
    const createdIds = changes.flatMap((change) =>
      change.kind === "grant" || change.kind === "create-group"
        ? [`${change.kind}:${change.id}`]
        : [],
    );
    return new Set(createdIds).size === createdIds.length;
  }, "An access batch cannot create duplicate IDs");
export const MemberChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set-kind"), value: MemberKindSchema }),
  z.strictObject({ kind: z.literal("set-state"), value: MemberStateSchema }),
  z.strictObject({ kind: z.literal("set-administrator"), value: z.boolean() }),
]);

export const PersonRefSchema = z.object({ id: UserIdSchema, name });
export const GroupRefSchema = z.object({
  id: uuid,
  name,
  builtin: z.literal("everyone").nullable(),
});
export const SubjectViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    userId: UserIdSchema,
    name,
    memberKind: MemberKindSchema,
    memberCount: count.optional(),
  }),
  z.object({ kind: z.literal("group"), groupId: uuid, name, memberCount: count.optional() }),
]);
const projectTargetView = ProjectTargetSchema.strip();
export const MemberCanSchema = z.object({
  setKind: CanSchema,
  setState: CanSchema,
  setAdministrator: CanSchema,
  revokeConnections: CanSchema,
});
export const GroupCanSchema = z.object({
  rename: CanSchema,
  editMembers: CanSchema,
  delete: CanSchema,
});
export const MemberSummarySchema = PersonRefSchema.extend({
  email: z.email().max(320),
  kind: MemberKindSchema,
  state: MemberStateSchema,
  administrator: z.boolean(),
  groupsPreview: z.array(GroupRefSchema).max(5),
  groupCount: count,
  joinedAt: timestamp,
  invitedBy: PersonRefSchema.nullable(),
  can: MemberCanSchema,
});
export const ConnectionViewSchema = z.object({
  id: connectionId,
  label: name,
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revoked: z.boolean(),
  canRevoke: CanSchema,
});
export const GroupSummarySchema = GroupRefSchema.extend({
  directCount: count,
  effectivePeopleCount: count,
  parentCount: count,
});
export const EntryViewSchema = z.object({
  id: uuid,
  subject: SubjectViewSchema,
  target: projectTargetView.extend({ name }),
  level: LevelSchema,
  grantedBy: PersonRefSchema,
  grantedAt: timestamp,
  revokedAt: timestamp.nullable(),
  can: z.object({ change: CanSchema, revoke: CanSchema }),
});
export function pageResultSchema<Item extends z.ZodType>(item: Item) {
  return z.object({ items: z.array(item).max(100), nextCursor: cursor.nullable() });
}
export const MemberDetailSchema = MemberSummarySchema.extend({
  directEntries: pageResultSchema(EntryViewSchema),
  groups: pageResultSchema(GroupRefSchema),
  effectiveProjects: z
    .array(z.object({ id: WorkspaceIdSchema, name, level: LevelSchema }))
    .max(128),
  connections: pageResultSchema(ConnectionViewSchema),
});
export const AudienceSchema = z.object({
  people: count,
  preview: z.array(PersonRefSchema.extend({ kind: MemberKindSchema })).max(5),
  groups: z.array(z.object({ id: uuid, name, count })).max(512),
  myLevel: LevelSchema.nullable(),
  managerCount: count,
});
export const ProjectAccessViewSchema = z.object({
  project: z.object({ id: WorkspaceIdSchema, name, color: MarkColorSchema }),
  accessRevision: RevisionSchema,
  audience: AudienceSchema,
  entries: pageResultSchema(EntryViewSchema).nullable(),
  managerNames: z.array(PersonRefSchema.extend({ kind: MemberKindSchema })).max(1024),
  iAmAdminNotMember: z.boolean(),
  runtime: z.lazy(() => RuntimeStateSchema),
  can: z.object({
    use: CanSchema,
    manage: CanSchema,
    addPeople: CanSchema,
    editInstructions: CanSchema,
    appointManager: CanSchema,
    selfGrant: CanSchema,
    delete: CanSchema.optional(),
  }),
});
export const TeamSummarySchema = z.object({
  revision: cursor,
  accessRevision: RevisionSchema,
  team: z.object({ id: DeploymentIdSchema, name }),
  me: z.object({
    id: UserIdSchema,
    kind: MemberKindSchema,
    state: MemberStateSchema,
    administrator: z.boolean(),
  }),
  projects: z
    .array(
      z.object({
        id: WorkspaceIdSchema,
        name,
        color: MarkColorSchema,
        level: LevelSchema,
        unread: z.boolean(),
        needsYou: count,
        lastActivity: timestamp.nullable(),
        canOpen: CanSchema,
        runtime: z.lazy(() => RuntimeStateSchema).optional(),
      }),
    )
    .max(128),
  needsYou: count,
  can: z.object({
    createProject: CanSchema,
    people: CanSchema,
    groups: CanSchema,
    audit: CanSchema,
    invite: CanSchema,
    computer: CanSchema.optional(),
    projects: CanSchema.optional(),
  }),
});
export const ModelSelectionInputSchema = ModelSelectionSchema.omit({ nativeModelId: true });
export const SettingsInputSchema = z.strictObject({
  harnessInstanceId: HarnessInstanceIdSchema,
  modelSelection: ModelSelectionInputSchema,
  accessMode: ThreadAccessModeSchema,
  instructions: z
    .string()
    .max(65536)
    .refine(
      (value) => utf8ByteLength(value) <= 65536,
      "Project instructions cannot exceed 65536 UTF-8 bytes",
    ),
  timeZone: TimeZoneSchema.pipe(z.string().max(64)),
});
export const SettingsSchema = z.object({
  ...SettingsInputSchema.shape,
  workspaceId: WorkspaceIdSchema,
  modelSelection: ModelSelectionViewSchema,
  revision: RevisionSchema,
  updatedBy: UserIdSchema,
  updatedAt: timestamp,
});
export const RuntimeStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum([
      "not-configured",
      "computer-offline",
      "engine-unavailable",
      "model-unavailable",
      "runner-update-required",
    ]),
  }),
]);
export const AccessPreviewSchema = z.object({
  accessRevision: RevisionSchema,
  allowed: z.boolean(),
  blockers: z
    .array(
      z.object({
        changeIndex: z.number().int().min(0).max(99),
        reason: TeamReasonSchema,
        capacity: z.object({ limit: z.string().min(1).max(120), maximum: count }).optional(),
      }),
    )
    .max(100),
  counts: z.object({ peopleGaining: count, peopleLosing: count, levelChanges: count }),
  changes: z
    .array(
      z.object({
        user: PersonRefSchema,
        project: projectTargetView,
        before: LevelSchema.nullable(),
        after: LevelSchema.nullable(),
      }),
    )
    .max(100),
  surviving: z
    .array(
      z.object({
        userId: UserIdSchema,
        name,
        project: projectTargetView,
        level: LevelSchema,
        entryIds: z.array(uuid).max(256),
      }),
    )
    .max(100),
  truncated: z.boolean(),
});
export const AccessExplanationSchema = z.object({
  accessRevision: RevisionSchema,
  subject: z.discriminatedUnion("kind", [
    SubjectSchema.options[0].strip(),
    SubjectSchema.options[1].strip(),
  ]),
  target: projectTargetView,
  effectiveLevel: LevelSchema.nullable(),
  entries: z.array(EntryViewSchema).max(200),
  groups: z.array(GroupRefSchema).max(512),
  edges: z
    .array(
      z.object({
        groupId: uuid,
        member: z.discriminatedUnion("kind", [
          SubjectSchema.options[0].strip(),
          SubjectSchema.options[1].strip(),
        ]),
      }),
    )
    .max(400),
  truncated: z.boolean(),
  nextCursor: cursor.nullable(),
});
export const MemberPreviewSchema = z.object({
  accessRevision: RevisionSchema,
  allowed: z.boolean(),
  reason: TeamReasonSchema.optional(),
  isLastAdmin: z.boolean(),
  counts: z.object({
    sessions: count,
    connections: count,
    pendingInputs: count,
    activeRuns: count,
    pendingRequests: count,
  }),
  projectsLosing: count,
  projectsChangingLevel: count,
});
const entrySummary = z.object({
  id: uuid,
  subject: z.discriminatedUnion("kind", [
    SubjectSchema.options[0].strip(),
    SubjectSchema.options[1].strip(),
  ]),
  target: projectTargetView,
  level: LevelSchema,
});
const memberSummary = z.object({
  id: UserIdSchema,
  kind: MemberKindSchema,
  state: MemberStateSchema,
  administrator: z.boolean(),
});
export const SafeChangeSummarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entry"),
    before: entrySummary.nullable(),
    after: entrySummary.nullable(),
  }),
  z.object({
    kind: z.literal("group"),
    before: GroupRefSchema.nullable(),
    after: GroupRefSchema.nullable(),
  }),
  z.object({
    kind: z.literal("member"),
    before: memberSummary.nullable(),
    after: memberSummary.nullable(),
  }),
]);
export const AuditItemSchema = z.object({
  id: idSchema("securityAudit"),
  at: timestamp,
  action: z.string().min(1).max(120),
  actor: PersonRefSchema.nullable(),
  target: z
    .object({
      kind: z.enum(["project", "group", "member", "connection", "invitation"]),
      id: z.string().min(1).max(200),
      name,
    })
    .nullable(),
  changes: z.array(SafeChangeSummarySchema).max(100),
});
export const MembershipTransitionSchema = z.object({
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  generation: RevisionSchema,
  previousGeneration: RevisionSchema.nullable(),
  state: z.enum(["active", "revoked"]),
  role: z.enum(["owner", "collaborator"]),
});
export const TeamInvitationSelectorSchema = z.string().regex(/^[A-Za-z0-9_-]{24,96}$/);
export const TeamInvitationVerifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const inviteShape = {
  teamName: name,
  inviterName: name,
  emailMasked: z.string().min(1).max(320),
  kind: MemberKindSchema,
  expiresAt: timestamp,
  signIn: IdentityConfigViewSchema,
};
export const InvitePreviewSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unavailable") }),
  z.strictObject({ state: z.literal("open"), ...inviteShape }),
  z.strictObject({ state: z.literal("used"), ...inviteShape }),
]);
export const InvitePreviewViewSchema = z.discriminatedUnion("state", [
  InvitePreviewSchema.options[0].strip(),
  InvitePreviewSchema.options[1].strip(),
  InvitePreviewSchema.options[2].strip(),
]);

export const TeamProjectListRowSchema = z.object({
  id: WorkspaceIdSchema,
  name,
  color: MarkColorSchema,
  people: count,
  myLevel: LevelSchema.nullable(),
});
export const TeamComputerViewSchema = z.object({
  computer: z
    .object({
      id: RunnerIdSchema,
      name,
      state: z.enum(["connected", "offline", "update-required"]),
      lastSeenAt: timestamp.nullable(),
    })
    .nullable(),
  can: z.object({ replace: CanSchema }),
});

export const teamReadSchemas = {
  "team.projects.list": {
    input: PageSchema.extend({ query: query.optional() }),
    output: pageResultSchema(TeamProjectListRowSchema).extend({ accessRevision: RevisionSchema }),
  },
  "team.computer.get": { input: z.strictObject({}), output: TeamComputerViewSchema },
  "team.invitations.list": {
    input: PageSchema,
    output: pageResultSchema(
      z.object({
        id: uuid,
        emailMasked: z.string().min(1).max(320),
        memberKind: MemberKindSchema,
        createdBy: PersonRefSchema,
        createdAt: timestamp,
        expiresAt: timestamp,
        state: z.enum(["open", "used", "revoked", "expired"]),
        can: z.object({ revoke: CanSchema }),
      }),
    ).extend({ accessRevision: RevisionSchema }),
  },
  "team.summary.get": {
    input: z.strictObject({ knownRevision: cursor.optional() }),
    output: z.union([
      TeamSummarySchema,
      z.object({ notModified: z.literal(true), revision: cursor }),
    ]),
  },
  "team.people.list": {
    input: PageSchema.extend({ query: query.optional(), state: MemberStateSchema.optional() }),
    output: pageResultSchema(MemberSummarySchema).extend({ accessRevision: RevisionSchema }),
  },
  "team.member.get": {
    input: z.strictObject({
      userId: UserIdSchema,
      entryPage: PageSchema.optional(),
      connectionPage: PageSchema.optional(),
      groupPage: PageSchema.optional(),
    }),
    output: MemberDetailSchema.extend({ accessRevision: RevisionSchema }),
  },
  "team.directory.search": {
    input: z.strictObject({
      workspaceId: WorkspaceIdSchema,
      query,
      limit: z.number().int().min(1).max(30).optional(),
    }),
    output: z.object({
      people: z.array(PersonRefSchema).max(30),
      groups: z.array(GroupRefSchema).max(30),
      accessRevision: RevisionSchema,
    }),
  },
  "team.groups.list": {
    input: PageSchema.extend({ query: query.optional() }),
    output: pageResultSchema(GroupSummarySchema).extend({
      accessRevision: RevisionSchema,
      can: z.object({ create: CanSchema }),
    }),
  },
  "team.group.get": {
    input: PageSchema.extend({ groupId: uuid }),
    output: GroupSummarySchema.extend({
      directMembers: pageResultSchema(SubjectViewSchema),
      parents: z.array(GroupRefSchema).max(512),
      accessRevision: RevisionSchema,
      can: GroupCanSchema,
    }),
  },
  "team.project.access.get": {
    input: PageSchema.extend({ workspaceId: WorkspaceIdSchema }),
    output: ProjectAccessViewSchema,
  },
  "team.access.explain": {
    input: z.strictObject({
      workspaceId: WorkspaceIdSchema,
      subject: SubjectSchema,
      cursor: cursor.optional(),
    }),
    output: AccessExplanationSchema,
  },
  "team.access.preview": {
    input: z.strictObject({ expectedRevision: RevisionSchema, changes: AccessChangesSchema }),
    output: AccessPreviewSchema,
  },
  "team.member.preview": {
    input: z.strictObject({ userId: UserIdSchema, change: MemberChangeSchema }),
    output: MemberPreviewSchema,
  },
  "team.audit.list": {
    input: PageSchema.extend({
      actorId: UserIdSchema.optional(),
      target: ProjectTargetSchema.optional(),
      action: z.string().min(1).max(120).optional(),
    }),
    output: pageResultSchema(AuditItemSchema),
  },
  "team.project.settings.get": {
    input: z.strictObject({ workspaceId: WorkspaceIdSchema }),
    output: z.object({
      settings: SettingsSchema.nullable(),
      runtime: RuntimeStateSchema,
      can: z.object({ edit: CanSchema }),
    }),
  },
  "team.project.runtimeChoices": {
    input: z.strictObject({ workspaceId: WorkspaceIdSchema }),
    output: z.object({
      instances: z
        .array(
          z.object({
            id: HarnessInstanceIdSchema,
            driverKind: HarnessIdSchema,
            name,
            models: z.array(ModelSelectionViewSchema).max(2000),
          }),
        )
        .max(100),
      revision: cursor,
    }),
  },
  "team.invitation.preview": {
    input: z.strictObject({ selector: TeamInvitationSelectorSchema }),
    output: InvitePreviewViewSchema,
  },
  "team.invitation.exchange": {
    input: z.strictObject({
      selector: TeamInvitationSelectorSchema,
      verifier: TeamInvitationVerifierSchema,
    }),
    output: z.object({ preview: InvitePreviewViewSchema }),
  },
  "team.invitation.accept": {
    input: z.strictObject({}),
    output: z.object({
      member: MemberSummarySchema,
      accessRevision: RevisionSchema,
    }),
  },
} as const;

export const TeamInvitationCreateCommandSchema = MutationBaseSchema.extend({
  type: z.literal("team.invitation.create"),
  id: uuid,
  selector: TeamInvitationSelectorSchema,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  intendedEmail: z.email().max(320),
  memberKind: MemberKindSchema,
  validFor: z.enum(["1d", "7d"]),
  trustedComputerConfirmed: z.boolean().optional(),
});

export const TeamCommandSchema = z.discriminatedUnion("type", [
  MutationBaseSchema.extend({
    type: z.literal("team.computer.replace"),
    expectedComputerId: RunnerIdSchema.nullable(),
  }),
  MutationBaseSchema.extend({
    type: z.literal("team.project.create"),
    name,
    color: MarkColorSchema,
  }),
  MutationBaseSchema.extend({
    type: z.literal("team.project.delete"),
    workspaceId: WorkspaceIdSchema,
  }),
  MutationBaseSchema.extend({ type: z.literal("team.access.apply"), changes: AccessChangesSchema }),
  MutationBaseSchema.extend({
    type: z.literal("team.access.selfGrant"),
    workspaceId: WorkspaceIdSchema,
  }),
  MutationBaseSchema.extend({
    type: z.literal("team.member.change"),
    userId: UserIdSchema,
    change: MemberChangeSchema,
  }),
  MutationBaseSchema.extend({ type: z.literal("team.connection.revoke"), connectionId }),
  MutationBaseSchema.extend({
    type: z.literal("team.project.settings.set"),
    workspaceId: WorkspaceIdSchema,
    expectedSettingsRevision: RevisionSchema.nullable(),
    settings: SettingsInputSchema,
  }),
  TeamInvitationCreateCommandSchema,
  MutationBaseSchema.extend({ type: z.literal("team.invitation.revoke"), invitationId: uuid }),
]);
const resultBase = z.object({ accessRevision: RevisionSchema, commandId: CommandIdSchema });
export const TeamCommandResultSchema = z.discriminatedUnion("type", [
  resultBase.extend({
    type: z.literal("team.computer.replace"),
    runnerImage: z.string().min(1).max(512).nullable().optional(),
    enrollmentId: z.string().min(1).max(256),
    token: z.string().min(16).max(4096),
    expiresAt: timestamp,
  }),
  resultBase.extend({ type: z.literal("team.project.create"), projectId: WorkspaceIdSchema }),
  resultBase.extend({ type: z.literal("team.project.delete") }),
  resultBase.extend({
    type: z.literal("team.access.apply"),
    transitions: z.array(MembershipTransitionSchema).max(2048),
  }),
  resultBase.extend({
    type: z.literal("team.access.selfGrant"),
    entryId: uuid,
    level: z.literal("use"),
  }),
  resultBase.extend({
    type: z.literal("team.member.change"),
    member: MemberSummarySchema,
    effects: z.literal("queued"),
  }),
  resultBase.extend({ type: z.literal("team.connection.revoke"), revoked: z.literal(true) }),
  resultBase.extend({ type: z.literal("team.project.settings.set"), settings: SettingsSchema }),
  resultBase.extend({
    type: z.literal("team.invitation.create"),
    invitationId: uuid,
    selector: TeamInvitationSelectorSchema,
    expiresAt: timestamp,
  }),
  resultBase.extend({ type: z.literal("team.invitation.revoke"), revoked: z.literal(true) }),
]);

export type Revision = z.infer<typeof RevisionSchema>;
export type Page = z.infer<typeof PageSchema>;
export type PageResult<Item> = { items: Item[]; nextCursor: string | null };
export type PersonRef = z.infer<typeof PersonRefSchema>;
export type MemberKind = z.infer<typeof MemberKindSchema>;
export type MemberState = z.infer<typeof MemberStateSchema>;
export type Level = z.infer<typeof LevelSchema>;
export type Subject = z.infer<typeof SubjectSchema>;
export type ProjectTarget = z.infer<typeof ProjectTargetSchema>;
export type Can = z.infer<typeof CanSchema>;
export type MemberCan = z.infer<typeof MemberCanSchema>;
export type GroupCan = z.infer<typeof GroupCanSchema>;
export type MutationBase = z.infer<typeof MutationBaseSchema>;
export type TeamReason = z.infer<typeof TeamReasonSchema>;
export type AccessChange = z.infer<typeof AccessChangeSchema>;
export type MemberChange = z.infer<typeof MemberChangeSchema>;
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
export type MemberDetail = z.infer<typeof MemberDetailSchema>;
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;
export type GroupRef = z.infer<typeof GroupRefSchema>;
export type SubjectView = z.infer<typeof SubjectViewSchema>;
export type GroupSummary = z.infer<typeof GroupSummarySchema>;
export type EntryView = z.infer<typeof EntryViewSchema>;
export type Audience = z.infer<typeof AudienceSchema>;
export type ProjectAccessView = z.infer<typeof ProjectAccessViewSchema>;
export type TeamSummary = z.infer<typeof TeamSummarySchema>;
export type ModelSelectionInput = z.infer<typeof ModelSelectionInputSchema>;
export type SettingsInput = z.infer<typeof SettingsInputSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type AccessPreview = z.infer<typeof AccessPreviewSchema>;
export type AccessExplanation = z.infer<typeof AccessExplanationSchema>;
export type MemberPreview = z.infer<typeof MemberPreviewSchema>;
export type SafeChangeSummary = z.infer<typeof SafeChangeSummarySchema>;
export type AuditItem = z.infer<typeof AuditItemSchema>;
export type MembershipTransition = z.infer<typeof MembershipTransitionSchema>;
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;
export type TeamCommand = z.infer<typeof TeamCommandSchema>;
export type TeamCommandResult = z.infer<typeof TeamCommandResultSchema>;

export const ConfirmedTeamInvitationCommandSchema = TeamInvitationCreateCommandSchema.extend({
  trustedComputerConfirmed: z.literal(true),
});
export type TeamComputerView = z.infer<typeof TeamComputerViewSchema>;
export type TeamProjectListRow = z.infer<typeof TeamProjectListRowSchema>;
