import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { hostApi } from "./host-api.js";
import {
  AccessChangeSchema,
  AccessChangesSchema,
  AccessExplanationSchema,
  AccessPreviewSchema,
  AuditItemSchema,
  InvitePreviewSchema,
  MemberChangeSchema,
  MemberPreviewSchema,
  PageSchema,
  ProjectAccessViewSchema,
  RevisionSchema,
  SettingsInputSchema,
  TeamCommandResultSchema,
  TeamCommandSchema,
  TeamSummarySchema,
  teamReadSchemas,
} from "./team-access.js";

const userId = createId("user");
const workspaceId = createId("workspace");
const groupId = "00000000-0000-4000-8000-000000000001";
const entryId = "00000000-0000-4000-8000-000000000002";
const person = { id: userId, name: "Maya" };
const group = { id: groupId, name: "Support", builtin: null };
const subject = { kind: "person", userId };
const target = { kind: "project", workspaceId };
const allowed = { allowed: true };
const denied = { allowed: false, reason: "project-manage-required" };
const memberCan = {
  setKind: allowed,
  setState: allowed,
  setAdministrator: allowed,
  revokeConnections: allowed,
};
const timestamp = "2026-11-10T12:00:00.000Z";
const page = { items: [], nextCursor: null };
const member = {
  ...person,
  email: "maya@example.test",
  kind: "full",
  state: "active",
  administrator: false,
  groupsPreview: [group],
  groupCount: 1,
  joinedAt: timestamp,
  invitedBy: null,
  can: memberCan,
};
const entry = {
  id: entryId,
  subject: { ...subject, name: person.name },
  target,
  level: "use",
  grantedBy: person,
  grantedAt: timestamp,
  revokedAt: null,
  can: { change: allowed, revoke: allowed },
};
const settings = {
  harnessInstanceId: createId("harnessInstance"),
  modelSelection: { providerId: "openai", modelId: "gpt-5.6-sol", options: { effort: "low" } },
  accessMode: "approval-required",
  instructions: "Work on Support.",
  timeZone: "America/New_York",
};
const savedSettings = {
  ...settings,
  workspaceId,
  revision: 1,
  updatedBy: userId,
  updatedAt: timestamp,
};
const grant = { kind: "grant", id: entryId, subject, target, level: "use" };
const changes = [grant];
const base = { expectedRevision: 1, idempotencyKey: "team-fixture" };
const commands = [
  { ...base, type: "team.project.create", name: "Support", color: "blue" },
  { ...base, type: "team.access.apply", changes },
  { ...base, type: "team.access.selfGrant", workspaceId },
  {
    ...base,
    type: "team.member.change",
    userId,
    change: { kind: "set-state", value: "suspended" },
  },
  { ...base, type: "team.connection.revoke", connectionId: `mcn_${groupId}` },
  {
    ...base,
    type: "team.project.settings.set",
    workspaceId,
    expectedSettingsRevision: null,
    settings,
  },
  {
    ...base,
    type: "team.invitation.create",
    id: groupId,
    selector: "s".repeat(24),
    tokenHash: "a".repeat(64),
    intendedEmail: "maya@example.test",
    memberKind: "guest",
    validFor: "7d",
  },
  { ...base, type: "team.invitation.revoke", invitationId: groupId },
];
const accessPreview = {
  accessRevision: 1,
  allowed: true,
  blockers: [],
  counts: { peopleGaining: 1, peopleLosing: 0, levelChanges: 0 },
  changes: [{ user: person, project: target, before: null, after: "use" }],
  surviving: [{ userId, project: target, level: "use", entryIds: [entryId] }],
  truncated: false,
};
const explanation = {
  accessRevision: 1,
  subject,
  target,
  effectiveLevel: "use",
  entries: [entry],
  groups: [group],
  edges: [{ groupId, member: subject }],
  truncated: false,
  nextCursor: null,
};
const memberPreview = {
  accessRevision: 1,
  allowed: true,
  isLastAdmin: false,
  counts: { sessions: 1, connections: 2, pendingInputs: 0, activeRuns: 3, pendingRequests: 0 },
  projectsLosing: 2,
  projectsChangingLevel: 0,
};
const projectAccess = {
  project: { id: workspaceId, name: "Support", color: "blue" },
  accessRevision: 1,
  audience: {
    people: 1,
    preview: [person],
    groups: [{ id: groupId, name: "Support", count: 1 }],
    myLevel: "use",
    managerCount: 1,
  },
  entries: { items: [entry], nextCursor: null },
  managerNames: [person],
  iAmAdminNotMember: false,
  can: {
    use: allowed,
    manage: denied,
    addPeople: denied,
    editInstructions: denied,
    appointManager: denied,
    selfGrant: denied,
  },
};
const summary = {
  revision: "private-revision",
  accessRevision: 1,
  team: { id: createId("deployment"), name: "Acme" },
  me: { id: userId, kind: "full", state: "active", administrator: false },
  projects: [
    {
      id: workspaceId,
      name: "Support",
      color: "blue",
      level: "use",
      unread: true,
      needsYou: 1,
      lastActivity: null,
      canOpen: allowed,
    },
  ],
  needsYou: 1,
  can: { createProject: allowed, people: denied, groups: denied, audit: denied, invite: denied },
};
const invite = {
  state: "open",
  teamName: "Acme",
  inviterName: "Maya",
  emailMasked: "m***@example.test",
  kind: "guest",
  expiresAt: timestamp,
  signIn: {
    deployment: { kind: "self-hosted", name: "Acme" },
    emailDeliveryAvailable: false,
    localPasswordEnabled: true,
    machineOwner: false,
    oidcProviders: [],
    passkeysEnabled: false,
    exposure: "networked",
    portalOrigin: null,
    publicOrigin: "https://acme.example.test",
    setupState: "complete",
    signupPolicy: "invite-only",
  },
};
const audit = {
  id: createId("securityAudit"),
  at: timestamp,
  action: "access.mutated",
  actor: person,
  target: { kind: "project", id: workspaceId, name: "Support" },
  changes: [
    { kind: "entry", before: null, after: { id: entryId, subject, target, level: "use" } },
    { kind: "group", before: group, after: null },
    {
      kind: "member",
      before: null,
      after: { id: userId, kind: "full", state: "active", administrator: true },
    },
  ],
};
const reads = {
  "team.summary.get": { input: { knownRevision: "private-revision" }, output: summary },
  "team.people.list": {
    input: { cursor: "next", limit: 30, query: "Maya", state: "active" },
    output: { items: [member], nextCursor: null, accessRevision: 1 },
  },
  "team.member.get": {
    input: { userId, entryPage: { limit: 30 }, connectionPage: { cursor: "next" }, groupPage: {} },
    output: {
      ...member,
      directEntries: page,
      groups: page,
      effectiveProjects: [{ id: workspaceId, level: "use" }],
      connections: {
        items: [
          {
            id: `mcn_${groupId}`,
            label: "Laptop",
            createdAt: timestamp,
            lastUsedAt: null,
            revoked: false,
            canRevoke: allowed,
          },
        ],
        nextCursor: null,
      },
      accessRevision: 1,
    },
  },
  "team.directory.search": {
    input: { workspaceId, query: "Maya", limit: 30 },
    output: { people: [person], groups: [group], accessRevision: 1 },
  },
  "team.groups.list": {
    input: { limit: 100, query: "Support" },
    output: {
      items: [{ ...group, directCount: 1, effectivePeopleCount: 1, parentCount: 0 }],
      nextCursor: null,
      accessRevision: 1,
      can: { create: allowed },
    },
  },
  "team.group.get": {
    input: { groupId, limit: 30 },
    output: {
      ...group,
      directCount: 1,
      effectivePeopleCount: 1,
      parentCount: 0,
      directMembers: { items: [{ ...subject, name: person.name }], nextCursor: null },
      parents: [],
      accessRevision: 1,
      can: { rename: allowed, editMembers: allowed, delete: allowed },
    },
  },
  "team.project.access.get": { input: { workspaceId, limit: 30 }, output: projectAccess },
  "team.access.explain": { input: { workspaceId, subject, cursor: "next" }, output: explanation },
  "team.access.preview": { input: { expectedRevision: 1, changes }, output: accessPreview },
  "team.member.preview": {
    input: { userId, change: { kind: "set-kind", value: "guest" } },
    output: memberPreview,
  },
  "team.audit.list": {
    input: { actorId: userId, target, action: "access.mutated", limit: 30 },
    output: { items: [audit], nextCursor: null },
  },
  "team.project.settings.get": {
    input: { workspaceId },
    output: { settings: savedSettings, runtime: { state: "ready" }, can: { edit: allowed } },
  },
  "team.project.runtimeChoices": {
    input: { workspaceId },
    output: {
      instances: [
        {
          id: settings.harnessInstanceId,
          driverKind: "codex",
          name: "Codex",
          models: [settings.modelSelection],
        },
      ],
      revision: "catalog",
    },
  },
  "team.invitation.preview": { input: { selector: "s".repeat(24) }, output: invite },
  "team.invitation.exchange": {
    input: { selector: "s".repeat(24), verifier: "v".repeat(43) },
    output: { preview: invite },
  },
  "team.invitation.accept": { input: {}, output: { member, accessRevision: 1 } },
} satisfies Record<keyof typeof teamReadSchemas, { input: object; output: object }>;

describe("team administration wire contract", () => {
  it.each(Object.entries(reads))(
    "accepts the documented %s request and view",
    (procedure, fixture) => {
      const schema = teamReadSchemas[procedure as keyof typeof teamReadSchemas];
      expect(schema.input.safeParse(fixture.input).success).toBe(true);
      expect(schema.output.safeParse(fixture.output).success).toBe(true);
      expect(schema.input.safeParse({ ...fixture.input, callerKind: "human" }).success).toBe(false);
    },
  );

  it.each(commands)("admits the strict $type command and its matching result", (command) => {
    expect(TeamCommandSchema.safeParse(command).success).toBe(true);
    expect(hostApi["commands.dispatch"].payload.safeParse(command).success).toBe(true);
    expect(TeamCommandSchema.safeParse({ ...command, actor: userId }).success).toBe(false);
    const results: Record<string, object> = {
      "team.project.create": { projectId: workspaceId },
      "team.access.apply": {
        transitions: [
          {
            userId,
            workspaceId,
            generation: 2,
            previousGeneration: 1,
            state: "active",
            role: "collaborator",
          },
        ],
      },
      "team.access.selfGrant": { entryId, level: "use" },
      "team.member.change": { member, effects: "queued" },
      "team.connection.revoke": { revoked: true },
      "team.project.settings.set": { settings: savedSettings },
      "team.invitation.create": {
        invitationId: groupId,
        selector: "s".repeat(24),
        expiresAt: timestamp,
      },
      "team.invitation.revoke": { revoked: true },
    };
    const result = {
      type: command.type,
      commandId: createId("command"),
      accessRevision: 2,
      ...results[command.type],
    };
    expect(TeamCommandResultSchema.safeParse(result).success).toBe(true);
    expect(hostApi["commands.dispatch"].success.safeParse(result).success).toBe(true);
  });

  it("accepts every ordered graph and member edit, but no internal mutation cases", () => {
    for (const change of [
      { kind: "create-group", id: groupId, name: "Support" },
      { kind: "rename-group", groupId, name: "Help" },
      { kind: "delete-group", groupId },
      { kind: "add-group-member", groupId, member: subject },
      { kind: "remove-group-member", groupId, member: { kind: "group", groupId: entryId } },
      grant,
      { kind: "revoke", entryId },
    ]) {
      expect(AccessChangeSchema.safeParse(change).success).toBe(true);
      expect(AccessChangeSchema.safeParse({ ...change, expiresAt: timestamp }).success).toBe(false);
    }
    for (const change of [
      { kind: "set-kind", value: "full" },
      { kind: "set-state", value: "removed" },
      { kind: "set-administrator", value: true },
    ]) {
      expect(MemberChangeSchema.safeParse(change).success).toBe(true);
      expect(MemberChangeSchema.safeParse({ ...change, authorityGeneration: 2 }).success).toBe(
        false,
      );
    }
    for (const change of [
      { kind: "member", userId, admit: true },
      { kind: "create-group", id: groupId, name: "Everyone", builtin: "everyone" },
      { ...grant, subject: { kind: "project", workspaceId } },
      { ...grant, target: { kind: "topic", topicId: groupId } },
      { ...grant, subject: { ...subject, actor: userId } },
      { ...grant, target: { ...target, actor: userId } },
      { ...grant, level: "owner" },
      { ...grant, id: "not-uuid" },
    ]) {
      expect(AccessChangeSchema.safeParse(change).success).toBe(false);
    }
  });

  it("rejects unsafe revisions, unbounded searches, paging and duplicate or oversized batches", () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(RevisionSchema.safeParse(revision).success).toBe(false);
    }
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { cursor: "" },
      { userId },
    ]) {
      expect(PageSchema.safeParse(input).success).toBe(false);
    }
    expect(PageSchema.parse({})).toEqual({});
    expect(
      teamReadSchemas["team.people.list"].input.safeParse({ query: "a".repeat(121) }).success,
    ).toBe(false);
    expect(
      teamReadSchemas["team.directory.search"].input.safeParse({
        workspaceId,
        query: "",
        limit: 31,
      }).success,
    ).toBe(false);
    expect(
      teamReadSchemas["team.member.get"].input.safeParse({ userId, entryPage: { userId } }).success,
    ).toBe(false);
    for (const batch of [
      [],
      [grant, grant],
      [grant, { ...grant, level: "manage" }],
      Array.from({ length: 101 }, () => ({ ...grant, id: crypto.randomUUID() })),
    ]) {
      expect(AccessChangesSchema.safeParse(batch).success).toBe(false);
    }
    expect(
      AccessChangesSchema.safeParse(
        Array.from({ length: 100 }, () => ({ ...grant, id: crypto.randomUUID() })),
      ).success,
    ).toBe(true);
  });

  it("keeps settings bounded and Host-derived catalog identifiers out of executable input", () => {
    for (const input of [
      { ...settings, modelSelection: { ...settings.modelSelection, nativeModelId: "provider-id" } },
      { ...settings, instructions: "😀".repeat(16385) },
      { ...settings, timeZone: "Invalid/Zone" },
      { ...settings, environmentId: createId("environment") },
    ]) {
      expect(SettingsInputSchema.safeParse(input).success).toBe(false);
    }
    expect(
      SettingsInputSchema.safeParse({ ...settings, instructions: "😀".repeat(16384) }).success,
    ).toBe(true);
  });

  it("keeps invitation proof separate from replayable commands and safe responses", () => {
    for (const state of ["open", "used"])
      expect(InvitePreviewSchema.safeParse({ ...invite, state }).success).toBe(true);
    expect(InvitePreviewSchema.safeParse({ state: "unavailable" }).success).toBe(true);
    expect(InvitePreviewSchema.safeParse({ ...invite, verifier: "secret" }).success).toBe(false);
    expect(
      InvitePreviewSchema.safeParse({ state: "unavailable", intendedEmail: "maya@example.test" })
        .success,
    ).toBe(false);
    const command = commands[6]!;
    for (const extra of [
      { verifier: "v".repeat(43) },
      { tokenHash: "A".repeat(64) },
      { tokenHash: "a".repeat(63) },
      { selector: "s".repeat(23) },
      { intendedEmail: "not-email" },
      { memberKind: "administrator" },
      { validFor: "30d" },
      { projects: [workspaceId] },
    ]) {
      expect(TeamCommandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
    }
    expect(
      teamReadSchemas["team.invitation.exchange"].input.safeParse({
        selector: "s".repeat(24),
        verifier: "short",
      }).success,
    ).toBe(false);
  });

  it("bounds expanded audience and advisory DAG responses without exposing content", () => {
    expect(
      TeamSummarySchema.safeParse({ ...summary, projects: Array(129).fill(summary.projects[0]) })
        .success,
    ).toBe(false);
    expect(
      ProjectAccessViewSchema.safeParse({
        ...projectAccess,
        audience: { ...projectAccess.audience, preview: Array(6).fill(person) },
      }).success,
    ).toBe(false);
    expect(
      AccessPreviewSchema.safeParse({
        ...accessPreview,
        changes: Array(101).fill(accessPreview.changes[0]),
      }).success,
    ).toBe(false);
    expect(
      AccessExplanationSchema.safeParse({
        ...explanation,
        edges: Array(401).fill(explanation.edges[0]),
      }).success,
    ).toBe(false);
    expect(
      AccessExplanationSchema.safeParse({ ...explanation, entries: Array(201).fill(entry) })
        .success,
    ).toBe(false);
    expect(
      MemberPreviewSchema.safeParse({ ...memberPreview, reason: "new-private-detail" }).success,
    ).toBe(false);
    const parsed = AuditItemSchema.parse({ ...audit, instructions: "private", verifier: "secret" });
    expect(parsed).not.toHaveProperty("instructions");
    expect(parsed).not.toHaveProperty("verifier");
    expect(
      teamReadSchemas["team.summary.get"].output.safeParse({
        notModified: true,
        revision: "private",
      }).success,
    ).toBe(true);
  });
});
