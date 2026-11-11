import { sha256 } from "@noble/hashes/sha2.js";
import {
  CommandIdSchema,
  DeploymentIdSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  ModelSelectionSchema,
  RunnerIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type MarkColor,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  HostApiErrorSchema,
  TeamCommandResultSchema,
  rpcSuccess,
  teamReadSchemas,
  type AccessChange,
  type AccessPreview,
  type Can,
  type EntryView,
  type GroupRef,
  type HostApiHandlers,
  type Level,
  type MemberCan,
  type MemberChange,
  type MemberKind,
  type MemberState,
  type MemberSummary,
  type PersonRef,
  type RuntimeState,
  type Settings,
  type Subject,
  type SubjectView,
  type TeamCommand,
  type TeamCommandResult,
  type TeamReason,
} from "@opensteer/protocol";
import type { z } from "zod";
import { HostClientRequestError } from "../host/client.js";
import { rpcErrorStatus } from "../host/host-session-client.js";

/**
 * Which team the preview plays. `absent` is today's Hosts: no capability, and
 * every team call refused as the dormant Host refuses it.
 */
export type MockTeamScenario =
  | "absent"
  | "admin"
  | "admin-stale"
  | "admin-empty"
  | "member"
  | "member-empty"
  | "guest"
  | "suspended"
  | "removed"
  | "fresh";

/**
 * `admin-stale` also has its computer offline. `-empty` is the same team with
 * this person on no Project. `fresh` is a new server: its owner, and nothing else.
 */
export const mockTeamScenarios: readonly MockTeamScenario[] = [
  "absent",
  "admin",
  "admin-stale",
  "admin-empty",
  "member",
  "member-empty",
  "guest",
  "suspended",
  "removed",
  "fresh",
];

type TeamReadHandlers = Pick<HostApiHandlers, keyof typeof teamReadSchemas>;

interface Person {
  readonly id: UserId;
  name: string;
  email: string;
  kind: MemberKind;
  state: MemberState;
  administrator: boolean;
  joinedAt: string;
  invitedBy: PersonRef | null;
  connections: {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    revoked: boolean;
  }[];
  work: { sessions: number; activeRuns: number; pendingRequests: number; pendingInputs: number };
}
interface Group {
  readonly id: string;
  name: string;
  readonly builtin: "everyone" | null;
  members: Subject[];
}
interface Entry {
  readonly id: string;
  readonly subject: Subject;
  readonly workspaceId: WorkspaceId;
  readonly level: Level;
  readonly grantedBy: PersonRef;
  readonly grantedAt: string;
}
interface Project {
  readonly id: WorkspaceId;
  name: string;
  color: MarkColor;
  settings: Settings | null;
  runtime: "ready" | Extract<RuntimeState, { state: "unavailable" }>["reason"];
}
interface Computer {
  readonly id: string;
  readonly name: string;
  state: "connected" | "offline" | "update-required";
  lastSeenAt: string | null;
}
interface Invitation {
  readonly id: string;
  readonly selector: string;
  readonly tokenHash: string;
  readonly email: string;
  readonly kind: MemberKind;
  readonly expiresAt: string;
  readonly createdBy: PersonRef;
  readonly createdAt: string;
  revoked: boolean;
  accepted: boolean;
}

const userId = (suffix: string) =>
  UserIdSchema.parse(`usr_00000000-0000-4000-8000-${suffix.padStart(12, "0")}`);
const groupId = (suffix: string) => `00000000-0000-4000-9000-${suffix.padStart(12, "0")}`;
const projectId = (suffix: string) =>
  WorkspaceIdSchema.parse(`wsp_00000000-0000-4000-8000-${suffix.padStart(12, "0")}`);

const viewerId = UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001");
const maya = userId("a1");
const dev = userId("a2");
const sam = userId("a3");
const kai = userId("a4");
const jordan = userId("a5");
const priya = userId("a6");
const leo = userId("a7");
const everyone = groupId("1");
const customerSuccess = groupId("2");
const supportTeam = groupId("3");
export const mockTeamProjects = {
  launch: projectId("2"),
  finance: projectId("3"),
  payroll: projectId("b1"),
  support: projectId("b4"),
} as const;
const claudeInstance = HarnessInstanceIdSchema.parse("hin_00000000-0000-4000-8000-0000000000c1");
const codexInstance = HarnessInstanceIdSchema.parse("hin_00000000-0000-4000-8000-0000000000c2");
/** An open invitation the preview can be opened on: `/join/<selector>#<verifier>`. */
export const mockTeamInvitation = {
  selector: "mockTeamInviteSelector0000000001",
  verifier: "mockTeamInviteVerifier000000000000000000001",
} as const;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const digest = (value: string) => hex(sha256(new TextEncoder().encode(value)));

function refusal(
  code: "forbidden" | "not_found" | "conflict" | "bad_request",
  reason: TeamReason,
  message: string,
) {
  return new HostClientRequestError({ code, message, reason, status: rpcErrorStatus(code) });
}
const allowed: Can = { allowed: true };
const denied = (reason?: TeamReason): Can =>
  reason ? { allowed: false, reason } : { allowed: false };

/**
 * One team, played for every client in the preview. Its `can` values are
 * fixture outcomes for the scenario's viewer; it expands groups only so the
 * counts and previews it shows stay consistent with its own fixtures.
 */
export class MockTeamAccess {
  readonly #deletedProjects = new Set<WorkspaceId>();
  readonly scenario: MockTeamScenario;
  readonly #now: () => Date;
  #revision = 41;
  #summaryRevision = 1;
  #commandCount = 0;
  #staleArmed: boolean;
  readonly #people = new Map<UserId, Person>();
  readonly #groups = new Map<string, Group>();
  #entries: Entry[] = [];
  readonly #projects = new Map<WorkspaceId, Project>();
  readonly #invitations = new Map<string, Invitation>();
  #admitted = false;
  #computer: Computer | null = null;
  /** The selector this browser proved, standing in for the Host's HttpOnly admission cookie. */
  #proof: string | null = null;

  constructor(scenario: MockTeamScenario = "absent", now: () => Date = () => new Date()) {
    this.scenario = scenario;
    this.#now = now;
    this.#staleArmed = scenario === "admin-stale";
    this.#seed();
  }

  get available(): boolean {
    return this.scenario !== "absent";
  }

  get #viewer(): Person {
    return this.#people.get(viewerId)!;
  }

  get #admin(): boolean {
    return this.#viewer.administrator && this.#viewer.state === "active";
  }

  #seed() {
    const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9, 30)).toISOString();
    const viewerKind: MemberKind = this.scenario === "guest" ? "guest" : "full";
    const viewerState: MemberState =
      this.scenario === "suspended"
        ? "suspended"
        : this.scenario === "removed"
          ? "removed"
          : "active";
    const person = (
      id: UserId,
      name: string,
      email: string,
      patch: Partial<Person> = {},
    ): Person => ({
      id,
      name,
      email,
      kind: "full",
      state: "active",
      administrator: false,
      joinedAt: at(3),
      invitedBy: { id: viewerId, name: "Alex Rivera" },
      connections: [],
      work: { sessions: 1, activeRuns: 0, pendingRequests: 0, pendingInputs: 0 },
      ...patch,
    });
    for (const p of [
      person(viewerId, "Alex Rivera", "alex@acme.example", {
        administrator: this.scenario.startsWith("admin") || this.scenario === "fresh",
        kind: viewerKind,
        state: viewerState,
        invitedBy: null,
        joinedAt: at(1),
        connections: [
          {
            id: "mcn_00000000-0000-4000-8000-0000000000d1",
            label: "Claude Code on MacBook Pro",
            createdAt: at(4),
            lastUsedAt: at(9),
            revoked: false,
          },
        ],
        work: { sessions: 2, activeRuns: 1, pendingRequests: 0, pendingInputs: 0 },
      }),
      person(maya, "Maya Chen", "maya@acme.example", {
        joinedAt: at(2),
        connections: [
          {
            id: "mcn_00000000-0000-4000-8000-0000000000d2",
            label: "Codex on Mac mini",
            createdAt: at(5),
            lastUsedAt: at(10),
            revoked: false,
          },
        ],
        work: { sessions: 3, activeRuns: 2, pendingRequests: 1, pendingInputs: 0 },
      }),
      person(dev, "Dev Patel", "dev@acme.example"),
      person(sam, "Sam Lee", "sam@acme.example", {
        work: { sessions: 2, activeRuns: 3, pendingRequests: 1, pendingInputs: 2 },
        connections: [
          {
            id: "mcn_00000000-0000-4000-8000-0000000000d3",
            label: "Claude Code on MacBook Air",
            createdAt: at(6),
            lastUsedAt: at(10),
            revoked: false,
          },
          {
            id: "mcn_00000000-0000-4000-8000-0000000000d4",
            label: "Cursor on Mac Studio",
            createdAt: at(6),
            lastUsedAt: null,
            revoked: true,
          },
        ],
      }),
      person(kai, "Kai Mori", "kai@acme.example"),
      person(jordan, "Jordan Lee", "jordan@partner.example", { kind: "guest" }),
      person(priya, "Priya Nair", "priya@acme.example", { state: "suspended" }),
      person(leo, "Leo Park", "leo@acme.example", { state: "removed" }),
    ])
      this.#people.set(p.id, p);
    this.#groups.set(everyone, {
      id: everyone,
      name: "Everyone",
      builtin: "everyone",
      members: [],
    });
    this.#groups.set(customerSuccess, {
      id: customerSuccess,
      name: "Customer success",
      builtin: null,
      members: [
        { kind: "group", groupId: supportTeam },
        { kind: "person", userId: kai },
      ],
    });
    this.#groups.set(supportTeam, {
      id: supportTeam,
      name: "Support team",
      builtin: null,
      members: [
        { kind: "person", userId: sam },
        { kind: "person", userId: dev },
        { kind: "person", userId: maya },
      ],
    });
    this.#syncEveryone();
    const grantedBy: PersonRef = { id: viewerId, name: "Alex Rivera" };
    const entry = (
      suffix: string,
      subject: Subject,
      workspaceId: WorkspaceId,
      level: Level,
      by: PersonRef = grantedBy,
      day = 4,
    ): Entry => ({
      id: `00000000-0000-4000-a000-${suffix.padStart(12, "0")}`,
      subject,
      workspaceId,
      level,
      grantedBy: by,
      grantedAt: at(day),
    });
    const { launch, finance, payroll, support } = mockTeamProjects;
    const onNone = this.scenario.endsWith("-empty");
    this.#entries = [
      entry("1", { kind: "group", groupId: customerSuccess }, launch, "use"),
      entry("2", { kind: "person", userId: maya }, launch, "manage"),
      entry(
        "3",
        { kind: "person", userId: sam },
        launch,
        "use",
        { id: maya, name: "Maya Chen" },
        5,
      ),
      entry(
        "4",
        { kind: "person", userId: viewerId },
        launch,
        this.scenario === "guest" ? "use" : "manage",
      ),
      entry("5", { kind: "group", groupId: onNone ? customerSuccess : everyone }, finance, "use"),
      entry("6", { kind: "person", userId: priya }, payroll, "manage"),
      entry("7", { kind: "person", userId: dev }, payroll, "use"),
      entry("8", { kind: "group", groupId: supportTeam }, support, "use"),
      entry("9", { kind: "person", userId: dev }, support, "manage"),
    ].filter((e) => !onNone || e.subject.kind !== "person" || e.subject.userId !== viewerId);
    const updatedAt = at(8);
    this.#projects.set(launch, {
      id: launch,
      name: "Customer launch",
      color: "green",
      runtime: "model-unavailable",
      settings: {
        workspaceId: launch,
        harnessInstanceId: claudeInstance,
        modelSelection: ModelSelectionSchema.parse({
          modelId: "claude-opus-4",
          options: {},
          providerId: "anthropic",
        }),
        accessMode: "auto-accept-edits",
        instructions: "Draft launch copy in Acme's voice. Ask before anything goes to customers.",
        timeZone: "Europe/London",
        revision: 3,
        updatedBy: maya,
        updatedAt,
      },
    });
    this.#projects.set(finance, {
      id: finance,
      name: "Finance & operations",
      color: "lime",
      runtime: "not-configured",
      settings: null,
    });
    this.#projects.set(payroll, {
      id: payroll,
      name: "Payroll",
      color: "magenta",
      runtime: "ready",
      settings: {
        workspaceId: payroll,
        harnessInstanceId: codexInstance,
        modelSelection: ModelSelectionSchema.parse({
          modelId: "gpt-5.6-sol",
          options: { effort: "medium" },
          providerId: "openai",
        }),
        accessMode: "approval-required",
        instructions: "Payroll runs. Never send money.",
        timeZone: "America/New_York",
        revision: 1,
        updatedBy: priya,
        updatedAt,
      },
    });
    this.#projects.set(support, {
      id: support,
      name: "Support",
      color: "blue",
      runtime: "not-configured",
      settings: null,
    });
    this.#computer = {
      id: RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-0000000000f1"),
      name: "acme-runner",
      state: this.scenario === "admin-stale" ? "offline" : "connected",
      lastSeenAt: at(10),
    };
    this.#invitations.set(mockTeamInvitation.selector, {
      id: "00000000-0000-4000-b000-000000000001",
      selector: mockTeamInvitation.selector,
      tokenHash: digest(mockTeamInvitation.verifier),
      email: "nina@acme.example",
      kind: "full",
      expiresAt: new Date(Date.UTC(2026, 10, 16, 17)).toISOString(),
      createdBy: { id: maya, name: "Maya Chen" },
      createdAt: new Date(Date.UTC(2026, 10, 9, 10)).toISOString(),
      revoked: false,
      accepted: false,
    });
    const settled = (suffix: string, email: string, state: "used" | "revoked", day: number) =>
      this.#invitations.set(`mockTeamSettledInvitation00000000${suffix}`, {
        id: `00000000-0000-4000-b000-00000000000${suffix}`,
        selector: `mockTeamSettledInvitation00000000${suffix}`,
        tokenHash: digest(`settled-${suffix}`),
        email,
        kind: state === "used" ? "guest" : "full",
        expiresAt: new Date(Date.UTC(2026, 10, day + 7, 9)).toISOString(),
        createdBy: { id: viewerId, name: "Alex Rivera" },
        createdAt: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
        revoked: state === "revoked",
        accepted: state === "used",
      });
    settled("2", "jordan@partner.example", "used", 2);
    settled("3", "omar@acme.example", "revoked", 5);
    if (this.scenario === "fresh") {
      for (const id of this.#people.keys()) if (id !== viewerId) this.#people.delete(id);
      for (const id of this.#groups.keys()) if (id !== everyone) this.#groups.delete(id);
      this.#entries = [];
      this.#projects.clear();
      this.#invitations.clear();
      this.#computer = null;
      this.#syncEveryone();
    }
  }

  #syncEveryone() {
    const group = this.#groups.get(everyone)!;
    group.members = [...this.#people.values()]
      .filter((p) => p.kind === "full" && p.state === "active")
      .map((p) => ({ kind: "person", userId: p.id }));
  }

  #person(id: string): Person {
    const found = this.#people.get(id as UserId);
    if (!found)
      throw refusal("not_found", "team-object-unavailable", "That person isn't available.");
    return found;
  }
  #group(id: string): Group {
    const found = this.#groups.get(id);
    if (!found)
      throw refusal("not_found", "team-object-unavailable", "That group isn't available.");
    return found;
  }
  #project(id: string): Project {
    const found = this.#projects.get(id as WorkspaceId);
    if (!found)
      throw refusal("not_found", "team-object-unavailable", "That project isn't available.");
    return found;
  }

  #requireMember() {
    if (this.scenario === "absent")
      throw refusal("forbidden", "team-unavailable", "Team administration is not available.");
    const { state } = this.#viewer;
    if (state === "suspended")
      throw refusal("forbidden", "member-suspended", "Your team access is suspended.");
    if (state === "removed")
      throw refusal("forbidden", "member-removed", "You were removed from the team.");
  }
  #requireAdmin() {
    this.#requireMember();
    if (!this.#admin)
      throw refusal("forbidden", "team-admin-required", "Only an administrator can do this.");
  }

  /** People a subject stands for, expanding nested groups. */
  #peopleOf(subject: Subject, groups = this.#groups, seen = new Set<string>()): Set<UserId> {
    if (subject.kind === "person") {
      const p = this.#people.get(subject.userId);
      return p && p.state === "active" ? new Set([p.id]) : new Set();
    }
    if (seen.has(subject.groupId)) return new Set();
    seen.add(subject.groupId);
    const out = new Set<UserId>();
    for (const member of groups.get(subject.groupId)?.members ?? [])
      for (const id of this.#peopleOf(member, groups, seen)) out.add(id);
    return out;
  }

  #levels(workspaceId: WorkspaceId, entries = this.#entries, groups = this.#groups) {
    const levels = new Map<UserId, Level>();
    for (const e of entries) {
      if (e.workspaceId !== workspaceId) continue;
      for (const id of this.#peopleOf(e.subject, groups)) {
        if (levels.get(id) !== "manage") levels.set(id, e.level);
      }
    }
    return levels;
  }

  #myLevel(workspaceId: WorkspaceId): Level | null {
    return this.#levels(workspaceId).get(viewerId) ?? null;
  }

  #canManage(workspaceId: WorkspaceId): boolean {
    return this.#myLevel(workspaceId) === "manage";
  }

  #canEditAccess(workspaceId: WorkspaceId): Can {
    return this.#admin || this.#canManage(workspaceId)
      ? allowed
      : denied("project-manage-required");
  }

  #subjectView(subject: Subject): SubjectView {
    if (subject.kind === "person")
      return {
        ...subject,
        name: this.#people.get(subject.userId)?.name ?? "Former member",
        memberKind: this.#people.get(subject.userId)?.kind ?? "guest",
      };
    const group = this.#groups.get(subject.groupId);
    return {
      ...subject,
      name: group?.name ?? "Deleted group",
      memberCount: this.#peopleOf(subject).size,
    };
  }

  #entryView(e: Entry): EntryView {
    const can = this.#canEditAccess(e.workspaceId);
    return {
      id: e.id,
      subject: this.#subjectView(e.subject),
      target: {
        kind: "project",
        workspaceId: e.workspaceId,
        name: this.#project(e.workspaceId).name,
      },
      level: e.level,
      grantedBy: e.grantedBy,
      grantedAt: e.grantedAt,
      revokedAt: null,
      can: { change: can, revoke: can },
    };
  }

  #groupRef(group: Group): GroupRef {
    return { id: group.id, name: group.name, builtin: group.builtin };
  }

  #groupsOf(subject: Subject): Group[] {
    return [...this.#groups.values()].filter((group) =>
      group.members.some(
        (m) =>
          m.kind === subject.kind &&
          (m.kind === "person"
            ? subject.kind === "person" && m.userId === subject.userId
            : subject.kind === "group" && m.groupId === subject.groupId),
      ),
    );
  }

  #adminCount() {
    return [...this.#people.values()].filter((p) => p.administrator && p.state === "active").length;
  }

  #memberCan(p: Person): MemberCan {
    if (!this.#admin)
      return {
        setKind: denied("team-admin-required"),
        setState: denied("team-admin-required"),
        setAdministrator: denied("team-admin-required"),
        revokeConnections: denied("team-admin-required"),
      };
    if (p.state === "removed")
      return {
        setKind: denied("member-removed"),
        setState: denied("member-removed"),
        setAdministrator: denied("member-removed"),
        revokeConnections: allowed,
      };
    const lastAdmin = p.administrator && p.state === "active" && this.#adminCount() === 1;
    return {
      setKind: lastAdmin ? denied("last-active-admin") : allowed,
      setState: lastAdmin ? denied("last-active-admin") : allowed,
      setAdministrator: lastAdmin ? denied("last-active-admin") : allowed,
      revokeConnections: allowed,
    };
  }

  #memberSummary(p: Person): MemberSummary {
    const groups = this.#groupsOf({ kind: "person", userId: p.id });
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      kind: p.kind,
      state: p.state,
      administrator: p.administrator,
      groupsPreview: groups.slice(0, 5).map((g) => this.#groupRef(g)),
      groupCount: groups.length,
      joinedAt: p.joinedAt,
      invitedBy: p.invitedBy,
      can: this.#memberCan(p),
    };
  }

  #summary() {
    this.#requireMember();
    const projects = [...this.#projects.values()].flatMap((project) => {
      const level = this.#myLevel(project.id);
      return level
        ? [
            {
              id: project.id,
              name: project.name,
              color: project.color,
              level,
              unread: project.id === mockTeamProjects.launch,
              needsYou: project.id === mockTeamProjects.launch ? 1 : 0,
              lastActivity: new Date(Date.UTC(2026, 10, 9, 15)).toISOString(),
              canOpen: allowed,
              runtime: this.#runtime(project),
            },
          ]
        : [];
    });
    const adminCan = this.#admin ? allowed : denied("team-admin-required");
    return {
      revision: `team-summary-${this.#summaryRevision}`,
      accessRevision: this.#revision,
      team: {
        id: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000e1"),
        name: "Acme",
      },
      me: {
        id: viewerId,
        kind: this.#viewer.kind,
        state: this.#viewer.state,
        administrator: this.#viewer.administrator,
      },
      projects,
      needsYou: projects.reduce((sum, p) => sum + p.needsYou, 0),
      can: {
        createProject: this.#viewer.kind === "full" ? allowed : denied(),
        people: adminCan,
        groups: adminCan,
        audit: adminCan,
        invite: adminCan,
        computer: adminCan,
      },
    };
  }

  /** Nothing runs without the computer, so its state is reported before a Project's own. */
  #runtime(project: Project): RuntimeState {
    if (this.#computer === null || this.#computer.state === "offline")
      return { state: "unavailable", reason: "computer-offline" };
    if (this.#computer.state === "update-required")
      return { state: "unavailable", reason: "runner-update-required" };
    if (project.runtime !== "ready") return { state: "unavailable", reason: project.runtime };
    return { state: "ready" };
  }

  /** The Projects this person is on, which are all a team place's snapshot holds. */
  reachableProjects(): Set<string> {
    if (!this.available || this.#viewer.state !== "active") return new Set();
    return new Set([...this.#projects.keys()].filter((id) => this.#myLevel(id) !== null));
  }

  /** The Host's snapshot audience for a Project: how many people, and this person's level. */
  audience(workspaceId: string): { people: number; myLevel: Level | null } | null {
    if (!this.#projects.has(workspaceId as WorkspaceId)) return null;
    const id = workspaceId as WorkspaceId;
    return { people: this.#levels(id).size, myLevel: this.#myLevel(id) };
  }

  /** A Project's runtime as its summary row reports it. */
  runtimeOf(workspaceId: string): RuntimeState | undefined {
    const project = this.#projects.get(workspaceId as WorkspaceId);
    return project ? this.#runtime(project) : undefined;
  }

  #projectAccess(workspaceId: WorkspaceId) {
    this.#requireMember();
    const project = this.#project(workspaceId);
    const myLevel = this.#myLevel(workspaceId);
    if (!myLevel && !this.#admin)
      throw refusal("not_found", "team-object-unavailable", "That project isn't available.");
    const levels = this.#levels(workspaceId);
    const managers = [...levels].filter(([, level]) => level === "manage").map(([id]) => id);
    const entries = this.#entries.filter((e) => e.workspaceId === workspaceId);
    const editable = this.#canEditAccess(workspaceId);
    const groups = entries.flatMap((e) =>
      e.subject.kind === "group"
        ? [
            {
              id: e.subject.groupId,
              name: this.#groups.get(e.subject.groupId)?.name ?? "Group",
              count: this.#peopleOf(e.subject).size,
            },
          ]
        : [],
    );
    return {
      project: { id: project.id, name: project.name, color: project.color },
      accessRevision: this.#revision,
      audience: {
        people: levels.size,
        preview: [...levels.keys()]
          .slice(0, 5)
          .map((id) => ({ id, name: this.#person(id).name, kind: this.#person(id).kind })),
        groups,
        myLevel,
        managerCount: managers.length,
      },
      entries: {
        items: entries
          .sort((a, b) => Number(b.subject.kind === "group") - Number(a.subject.kind === "group"))
          .map((e) => this.#entryView(e)),
        nextCursor: null,
      },
      managerNames: managers.map((id) => ({
        id,
        name: this.#person(id).name,
        kind: this.#person(id).kind,
      })),
      iAmAdminNotMember: this.#admin && myLevel === null,
      runtime: this.#runtime(project),
      can: {
        use: myLevel ? allowed : denied("membership-lost"),
        manage: myLevel === "manage" ? allowed : denied("project-manage-required"),
        addPeople: editable,
        editInstructions: myLevel === "manage" ? allowed : denied("project-manage-required"),
        appointManager: editable,
        delete: editable,
        selfGrant:
          this.#admin && myLevel === null
            ? allowed
            : denied(this.#admin ? undefined : "team-admin-required"),
      },
    };
  }

  #explain(workspaceId: WorkspaceId, subject: Subject) {
    this.#requireMember();
    this.#project(workspaceId);
    const self = subject.kind === "person" && subject.userId === viewerId;
    if (!self && !this.#admin && !this.#canManage(workspaceId))
      throw refusal("forbidden", "project-manage-required", "Only a manager can see why.");
    const entries = this.#entries.filter((e) => e.workspaceId === workspaceId);
    const relevant = new Set<string>();
    const edges: { groupId: string; member: Subject }[] = [];
    const visit = (node: Subject) => {
      for (const group of this.#groupsOf(node)) {
        edges.push({ groupId: group.id, member: node });
        if (relevant.has(group.id)) continue;
        relevant.add(group.id);
        visit({ kind: "group", groupId: group.id });
      }
    };
    visit(subject);
    const reach = (s: Subject) =>
      s.kind === "person"
        ? subject.kind === "person" && s.userId === subject.userId
        : relevant.has(s.groupId) || (subject.kind === "group" && subject.groupId === s.groupId);
    const paths = entries.filter((e) => reach(e.subject));
    const effective = paths.some((e) => e.level === "manage")
      ? "manage"
      : paths.length
        ? "use"
        : null;
    return {
      accessRevision: this.#revision,
      subject,
      target: { kind: "project" as const, workspaceId },
      effectiveLevel: effective,
      entries: paths.map((e) => this.#entryView(e)),
      groups: [...relevant].map((id) => this.#groupRef(this.#groups.get(id)!)),
      edges,
      truncated: false,
      nextCursor: null,
    };
  }

  /** Applies changes to copies, refusing what this team's fixtures refuse. */
  #plan(changes: readonly AccessChange[]) {
    const groups = new Map(
      [...this.#groups].map(([id, g]) => [id, { ...g, members: [...g.members] }]),
    );
    let entries = [...this.#entries];
    const blockers: AccessPreview["blockers"] = [];
    changes.forEach((change, changeIndex) => {
      const block = (reason: TeamReason) => blockers.push({ changeIndex, reason });
      switch (change.kind) {
        case "grant": {
          if (!this.#admin && !this.#canManage(change.target.workspaceId))
            return block("project-manage-required");
          if (!this.#projects.has(change.target.workspaceId))
            return block("team-object-unavailable");
          entries.push({
            id: change.id,
            subject: change.subject,
            workspaceId: change.target.workspaceId,
            level: change.level,
            grantedBy: { id: viewerId, name: this.#viewer.name },
            grantedAt: this.#now().toISOString(),
          });
          return;
        }
        case "revoke": {
          const found = entries.find((e) => e.id === change.entryId);
          if (!found) return block("team-object-unavailable");
          if (!this.#admin && !this.#canManage(found.workspaceId))
            return block("project-manage-required");
          entries = entries.filter((e) => e.id !== change.entryId);
          return;
        }
        case "create-group":
          if (!this.#admin) return block("team-admin-required");
          groups.set(change.id, { id: change.id, name: change.name, builtin: null, members: [] });
          return;
        case "rename-group":
        case "delete-group": {
          if (!this.#admin) return block("team-admin-required");
          const group = groups.get(change.groupId);
          if (!group) return block("team-object-unavailable");
          if (group.builtin) return block("immutable-everyone");
          if (change.kind === "rename-group") group.name = change.name;
          else {
            groups.delete(change.groupId);
            for (const g of groups.values())
              g.members = g.members.filter(
                (m) => !(m.kind === "group" && m.groupId === change.groupId),
              );
            entries = entries.filter(
              (e) => !(e.subject.kind === "group" && e.subject.groupId === change.groupId),
            );
          }
          return;
        }
        case "add-group-member":
        case "remove-group-member": {
          if (!this.#admin) return block("team-admin-required");
          const group = groups.get(change.groupId);
          if (!group) return block("team-object-unavailable");
          if (group.builtin) return block("immutable-everyone");
          const same = (m: Subject) =>
            m.kind === change.member.kind &&
            (m.kind === "person"
              ? change.member.kind === "person" && m.userId === change.member.userId
              : change.member.kind === "group" && m.groupId === change.member.groupId);
          if (change.kind === "remove-group-member") {
            group.members = group.members.filter((m) => !same(m));
            return;
          }
          if (change.member.kind === "group") {
            if (change.member.groupId === change.groupId) return block("access-cycle");
            const inside = this.#descendantGroups(change.member.groupId, groups);
            if (inside.has(change.groupId)) return block("access-cycle");
            if (!groups.has(change.member.groupId)) return block("invalid-subject");
          } else if (this.#people.get(change.member.userId)?.state !== "active") {
            return block("invalid-subject");
          }
          if (!group.members.some(same)) group.members.push(change.member);
          return;
        }
      }
    });
    return { groups, entries, blockers };
  }

  #descendantGroups(id: string, groups: Map<string, Group>, seen = new Set<string>()): Set<string> {
    for (const m of groups.get(id)?.members ?? []) {
      if (m.kind !== "group" || seen.has(m.groupId)) continue;
      seen.add(m.groupId);
      this.#descendantGroups(m.groupId, groups, seen);
    }
    return seen;
  }

  #preview(expectedRevision: number, changes: readonly AccessChange[]): AccessPreview {
    this.#requireMember();
    if (expectedRevision !== this.#revision)
      throw refusal("conflict", "access-revision-changed", "Access changed since this was read.");
    const plan = this.#plan(changes);
    const out: AccessPreview["changes"] = [];
    const surviving: AccessPreview["surviving"] = [];
    let peopleGaining = 0;
    let peopleLosing = 0;
    let levelChanges = 0;
    for (const project of this.#projects.values()) {
      const before = this.#levels(project.id);
      const after = this.#levels(project.id, plan.entries, plan.groups);
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const b = before.get(id) ?? null;
        const a = after.get(id) ?? null;
        if (b === a) {
          const touched = changes.some(
            (c) =>
              c.kind === "revoke" &&
              this.#entries.some(
                (e) =>
                  e.id === c.entryId &&
                  e.workspaceId === project.id &&
                  e.subject.kind === "person" &&
                  e.subject.userId === id,
              ),
          );
          if (touched && a)
            surviving.push({
              userId: id,
              name: this.#person(id).name,
              project: { kind: "project", workspaceId: project.id },
              level: a,
              entryIds: plan.entries
                .filter(
                  (e) =>
                    e.workspaceId === project.id && this.#peopleOf(e.subject, plan.groups).has(id),
                )
                .map((e) => e.id),
            });
          continue;
        }
        if (b === null) peopleGaining += 1;
        else if (a === null) peopleLosing += 1;
        else levelChanges += 1;
        out.push({
          user: { id, name: this.#person(id).name },
          project: { kind: "project", workspaceId: project.id },
          before: b,
          after: a,
        });
      }
    }
    return {
      accessRevision: this.#revision,
      allowed: plan.blockers.length === 0,
      blockers: plan.blockers,
      counts: { peopleGaining, peopleLosing, levelChanges },
      changes: out.slice(0, 100),
      surviving: surviving.slice(0, 100),
      truncated: out.length > 100,
    };
  }

  #memberPreview(id: UserId, change: MemberChange) {
    this.#requireAdmin();
    const p = this.#person(id);
    const can = this.#memberCan(p);
    const gate =
      change.kind === "set-kind"
        ? can.setKind
        : change.kind === "set-state"
          ? can.setState
          : can.setAdministrator;
    const losing =
      change.kind === "set-state" && change.value !== "active"
        ? [...this.#projects.values()].filter((project) => this.#levels(project.id).has(id)).length
        : change.kind === "set-kind" && change.value === "guest"
          ? this.#entries.filter(
              (e) => e.subject.kind === "group" && e.subject.groupId === everyone,
            ).length
          : 0;
    const ends =
      change.kind !== "set-kind" && !(change.kind === "set-state" && change.value === "active");
    return {
      accessRevision: this.#revision,
      allowed: gate.allowed,
      ...(gate.reason ? { reason: gate.reason } : {}),
      isLastAdmin: p.administrator && this.#adminCount() === 1,
      counts: {
        sessions: ends ? p.work.sessions : 0,
        connections: ends ? p.connections.filter((c) => !c.revoked).length : 0,
        pendingInputs: ends ? p.work.pendingInputs : 0,
        activeRuns: ends ? p.work.activeRuns : 0,
        pendingRequests: ends ? p.work.pendingRequests : 0,
      },
      projectsLosing: losing,
      projectsChangingLevel: 0,
    };
  }

  #bump() {
    this.#revision += 1;
    this.#summaryRevision += 1;
  }

  #checkRevision(expected: number) {
    if (this.#staleArmed) {
      this.#staleArmed = false;
      this.#bump();
      throw refusal("conflict", "access-revision-changed", "Access changed since this was read.");
    }
    if (expected !== this.#revision)
      throw refusal("conflict", "access-revision-changed", "Access changed since this was read.");
  }

  #commandId() {
    this.#commandCount += 1;
    return CommandIdSchema.parse(
      `cmd_00000000-0000-4000-8000-${this.#commandCount.toString(16).padStart(12, "0")}`,
    );
  }

  /** The Host's answer to one team command; refusals throw with their reason. */
  command(
    command: TeamCommand,
    createProject: (name: string, color: MarkColor) => Promise<WorkspaceId>,
  ): Promise<TeamCommandResult> {
    return this.#command(command, createProject).then((result) =>
      TeamCommandResultSchema.parse(result),
    );
  }

  async #command(
    command: TeamCommand,
    createProject: (name: string, color: MarkColor) => Promise<WorkspaceId>,
  ) {
    this.#requireMember();
    const base = () => ({ accessRevision: this.#revision, commandId: this.#commandId() });
    switch (command.type) {
      case "team.computer.replace": {
        this.#requireAdmin();
        this.#checkRevision(command.expectedRevision);
        if ((this.#computer?.id ?? null) !== command.expectedComputerId)
          throw refusal(
            "conflict",
            "team-object-unavailable",
            "The team's computer changed since this screen was opened.",
          );
        // The old computer stops at once; the new one joins with this code.
        this.#computer = null;
        this.#bump();
        const expiresAt = new Date(this.#now().getTime() + 15 * 60_000).toISOString();
        return TeamCommandResultSchema.parse({
          ...base(),
          type: command.type,
          enrollmentId: `ren_00000000-0000-4000-8000-${String(this.#commandCount).padStart(12, "0")}`,
          token: `MOCK-TEAM-COMPUTER-CODE-${String(this.#commandCount).padStart(4, "0")}`,
          expiresAt,
        });
      }
      case "team.project.delete": {
        if (this.#deletedProjects.has(command.workspaceId))
          return { type: command.type, ...base() };
        if (!this.#canEditAccess(command.workspaceId).allowed)
          throw refusal("forbidden", "project-manage-required", "Project management is required.");
        this.#project(command.workspaceId);
        this.#checkRevision(command.expectedRevision);
        this.#projects.delete(command.workspaceId);
        this.#entries = this.#entries.filter((entry) => entry.workspaceId !== command.workspaceId);
        this.#deletedProjects.add(command.workspaceId);
        this.#bump();
        return { type: command.type, ...base() };
      }
      case "team.project.create": {
        if (this.#viewer.kind !== "full")
          throw refusal("forbidden", "team-admin-required", "Guests can't create projects.");
        this.#checkRevision(command.expectedRevision);
        const id = await createProject(command.name, command.color);
        this.#projects.set(id, {
          id,
          name: command.name,
          color: command.color,
          settings: null,
          runtime: "not-configured",
        });
        this.#entries.push({
          id: globalThis.crypto.randomUUID(),
          subject: { kind: "person", userId: viewerId },
          workspaceId: id,
          level: "manage",
          grantedBy: { id: viewerId, name: this.#viewer.name },
          grantedAt: this.#now().toISOString(),
        });
        this.#bump();
        return { type: command.type, ...base(), projectId: id };
      }
      case "team.access.apply": {
        this.#checkRevision(command.expectedRevision);
        const plan = this.#plan(command.changes);
        const blocker = plan.blockers[0];
        if (blocker)
          throw refusal(
            blocker.reason === "project-manage-required" || blocker.reason === "team-admin-required"
              ? "forbidden"
              : "bad_request",
            blocker.reason,
            "This change was refused.",
          );
        this.#groups.clear();
        for (const [id, g] of plan.groups) this.#groups.set(id, g);
        this.#entries = plan.entries;
        this.#bump();
        return { type: command.type, ...base(), transitions: [] };
      }
      case "team.access.selfGrant": {
        this.#requireAdmin();
        this.#checkRevision(command.expectedRevision);
        if (this.#myLevel(command.workspaceId))
          throw refusal("conflict", "access-revision-changed", "You already have access.");
        const entryId = globalThis.crypto.randomUUID();
        this.#entries.push({
          id: entryId,
          subject: { kind: "person", userId: viewerId },
          workspaceId: command.workspaceId,
          level: "use",
          grantedBy: { id: viewerId, name: this.#viewer.name },
          grantedAt: this.#now().toISOString(),
        });
        this.#bump();
        return { type: command.type, ...base(), entryId, level: "use" as const };
      }
      case "team.member.change": {
        this.#requireAdmin();
        this.#checkRevision(command.expectedRevision);
        const preview = this.#memberPreview(command.userId, command.change);
        if (!preview.allowed)
          throw refusal(
            "conflict",
            preview.reason ?? "last-active-admin",
            "This change was refused.",
          );
        const p = this.#person(command.userId);
        if (command.change.kind === "set-kind") p.kind = command.change.value;
        else if (command.change.kind === "set-administrator")
          p.administrator = command.change.value;
        else {
          p.state = command.change.value;
          if (p.state !== "active")
            p.work = { sessions: 0, activeRuns: 0, pendingRequests: 0, pendingInputs: 0 };
          if (p.state !== "active") for (const c of p.connections) c.revoked = true;
        }
        this.#syncEveryone();
        this.#bump();
        return {
          type: command.type,
          ...base(),
          member: this.#memberSummary(p),
          effects: "queued" as const,
        };
      }
      case "team.connection.revoke": {
        const owner = [...this.#people.values()].find((p) =>
          p.connections.some((c) => c.id === command.connectionId),
        );
        if (!owner)
          throw refusal("not_found", "team-object-unavailable", "That connection isn't available.");
        if (!this.#admin && owner.id !== viewerId)
          throw refusal("forbidden", "team-admin-required", "Only an admin can do this.");
        this.#checkRevision(command.expectedRevision);
        for (const c of owner.connections) if (c.id === command.connectionId) c.revoked = true;
        return { type: command.type, ...base(), revoked: true as const };
      }
      case "team.project.settings.set": {
        this.#checkRevision(command.expectedRevision);
        const project = this.#project(command.workspaceId);
        if (!this.#canManage(project.id))
          throw refusal(
            "forbidden",
            "project-manage-required",
            "Only a manager can change settings.",
          );
        if ((project.settings?.revision ?? null) !== command.expectedSettingsRevision)
          throw refusal(
            "conflict",
            "settings-revision-changed",
            "Settings changed since this was read.",
          );
        project.settings = {
          ...command.settings,
          workspaceId: project.id,
          modelSelection: command.settings.modelSelection,
          revision: (project.settings?.revision ?? 0) + 1,
          updatedBy: viewerId,
          updatedAt: this.#now().toISOString(),
        };
        project.runtime = "ready";
        return { type: command.type, ...base(), settings: project.settings };
      }
      case "team.invitation.create": {
        this.#requireAdmin();
        this.#checkRevision(command.expectedRevision);
        const days = command.validFor === "1d" ? 1 : 7;
        const expiresAt = new Date(this.#now().getTime() + days * 86_400_000).toISOString();
        this.#invitations.set(command.selector, {
          id: command.id,
          selector: command.selector,
          tokenHash: command.tokenHash,
          email: command.intendedEmail,
          kind: command.memberKind,
          expiresAt,
          createdBy: { id: viewerId, name: this.#viewer.name },
          createdAt: this.#now().toISOString(),
          revoked: false,
          accepted: false,
        });
        return {
          type: command.type,
          ...base(),
          invitationId: command.id,
          selector: command.selector,
          expiresAt,
        };
      }
      case "team.invitation.revoke": {
        this.#requireAdmin();
        this.#checkRevision(command.expectedRevision);
        const invitation = [...this.#invitations.values()].find(
          (i) => i.id === command.invitationId,
        );
        if (!invitation || invitation.revoked || invitation.accepted)
          throw refusal("conflict", "invite-unavailable", "That invite can't be revoked.");
        invitation.revoked = true;
        return { type: command.type, ...base(), revoked: true as const };
      }
    }
  }

  #invitePreview(selector: string) {
    if (this.scenario === "absent")
      throw refusal("forbidden", "team-unavailable", "Team administration is not available.");
    const invitation = this.#invitations.get(selector);
    if (!invitation || invitation.revoked || new Date(invitation.expiresAt) <= this.#now())
      return { state: "unavailable" as const };
    const [local = "", domain = ""] = invitation.email.split("@");
    return {
      state: invitation.accepted ? ("used" as const) : ("open" as const),
      teamName: "Acme",
      inviterName: "Alex Rivera",
      emailMasked: `${local.slice(0, 1)}•••@${domain}`,
      kind: invitation.kind,
      expiresAt: invitation.expiresAt,
      signIn: {
        deployment: { kind: "self-hosted" as const, name: "Acme" },
        emailDeliveryAvailable: false,
        exposure: "networked" as const,
        localPasswordEnabled: true,
        machineOwner: false,
        oidcProviders: [],
        passkeysEnabled: false,
        portalOrigin: null,
        publicOrigin: "https://acme.example",
        setupState: "complete" as const,
        signupPolicy: "invite-only" as const,
      },
    };
  }

  /** Every team read the Host serves, answered from this team's fixtures. */
  handlers(): TeamReadHandlers {
    const run =
      <Name extends keyof typeof teamReadSchemas>(name: Name, answer: () => unknown) =>
      async () => {
        try {
          return rpcSuccess(
            teamReadSchemas[name].output.parse(answer()) as z.output<
              (typeof teamReadSchemas)[Name]["output"]
            >,
          );
        } catch (error) {
          if (!(error instanceof HostClientRequestError)) throw error;
          return {
            ok: false as const,
            error: HostApiErrorSchema.parse({
              code: error.code,
              message: error.message,
              reason: error.reason,
              retryable:
                error.reason === "access-revision-changed" ||
                error.reason === "settings-revision-changed",
            }),
          };
        }
      };
    const page = <T>(
      items: readonly T[],
      input: { cursor?: string | undefined; limit?: number | undefined },
    ) => {
      const start = input.cursor ? Number(input.cursor) : 0;
      const size = input.limit ?? 30;
      const next = start + size < items.length ? String(start + size) : null;
      return { items: items.slice(start, start + size), nextCursor: next };
    };
    const matches = (text: string, query: string | undefined) =>
      !query || text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    return {
      "team.projects.list": (input) =>
        run("team.projects.list", () => {
          this.#requireAdmin();
          const rows = [...this.#projects.values()]
            .filter((project) => matches(project.name, input.query))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((project) => ({
              id: project.id,
              name: project.name,
              color: project.color,
              people: this.#levels(project.id).size,
              myLevel: this.#myLevel(project.id),
            }));
          return { ...page(rows, input), accessRevision: this.#revision };
        })(),
      "team.computer.get": run("team.computer.get", () => {
        this.#requireAdmin();
        return {
          computer: this.#computer ? { ...this.#computer } : null,
          // With none, replacing it is connecting the first one.
          can: { replace: allowed },
        };
      }),
      "team.invitations.list": (input) =>
        run("team.invitations.list", () => {
          this.#requireAdmin();
          return {
            ...page(
              [...this.#invitations.values()]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((invitation) => ({
                  id: invitation.id,
                  emailMasked: `${invitation.email.slice(0, 1)}***${invitation.email.slice(invitation.email.indexOf("@"))}`,
                  memberKind: invitation.kind,
                  createdBy: invitation.createdBy,
                  createdAt: invitation.createdAt,
                  expiresAt: invitation.expiresAt,
                  state: invitation.revoked
                    ? "revoked"
                    : invitation.accepted
                      ? "used"
                      : new Date(invitation.expiresAt) <= this.#now()
                        ? "expired"
                        : "open",
                  can: {
                    revoke:
                      invitation.revoked || invitation.accepted
                        ? denied("invite-unavailable")
                        : allowed,
                  },
                })),
              input,
            ),
            accessRevision: this.#revision,
          };
        })(),
      "team.summary.get": (input) =>
        run("team.summary.get", () => {
          const summary = this.#summary();
          return input.knownRevision === summary.revision
            ? { notModified: true as const, revision: summary.revision }
            : summary;
        })(),
      "team.people.list": (input) =>
        run("team.people.list", () => {
          this.#requireAdmin();
          const people = [...this.#people.values()]
            .filter((p) => (input.state ? p.state === input.state : true))
            .filter((p) => matches(`${p.name} ${p.email}`, input.query))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => this.#memberSummary(p));
          return { ...page(people, input), accessRevision: this.#revision };
        })(),
      "team.member.get": (input) =>
        run("team.member.get", () => {
          this.#requireAdmin();
          const p = this.#person(input.userId);
          const subject: Subject = { kind: "person", userId: p.id };
          const direct = this.#entries.filter(
            (e) => e.subject.kind === "person" && e.subject.userId === p.id,
          );
          return {
            ...this.#memberSummary(p),
            directEntries: page(
              direct.map((e) => this.#entryView(e)),
              input.entryPage ?? {},
            ),
            groups: page(
              this.#groupsOf(subject).map((g) => this.#groupRef(g)),
              input.groupPage ?? {},
            ),
            effectiveProjects: [...this.#projects.values()].flatMap((project) => {
              const level = this.#levels(project.id).get(p.id);
              return level ? [{ id: project.id, name: project.name, level }] : [];
            }),
            connections: page(
              p.connections.map((c) => ({
                ...c,
                canRevoke: c.revoked ? denied("connection-revoked") : allowed,
              })),
              input.connectionPage ?? {},
            ),
            accessRevision: this.#revision,
          };
        })(),
      "team.directory.search": (input) =>
        run("team.directory.search", () => {
          this.#requireMember();
          this.#project(input.workspaceId);
          if (!this.#admin && !this.#canManage(input.workspaceId))
            throw refusal("forbidden", "project-manage-required", "Only a manager can add people.");
          const limit = input.limit ?? 20;
          return {
            people: [...this.#people.values()]
              .filter(
                (p) =>
                  p.state === "active" &&
                  matches(`${p.name} ${this.#admin ? p.email : ""}`, input.query),
              )
              .slice(0, limit)
              .map((p) => ({ id: p.id, name: p.name })),
            groups: [...this.#groups.values()]
              .filter((g) => matches(g.name, input.query))
              .slice(0, limit)
              .map((g) => this.#groupRef(g)),
            accessRevision: this.#revision,
          };
        })(),
      "team.groups.list": (input) =>
        run("team.groups.list", () => {
          this.#requireAdmin();
          const groups = [...this.#groups.values()]
            .filter((g) => matches(g.name, input.query))
            .sort(
              (a, b) =>
                Number(b.builtin !== null) - Number(a.builtin !== null) ||
                a.name.localeCompare(b.name),
            )
            .map((g) => this.#groupSummary(g));
          return {
            ...page(groups, input),
            accessRevision: this.#revision,
            can: { create: allowed },
          };
        })(),
      "team.group.get": (input) =>
        run("team.group.get", () => {
          this.#requireAdmin();
          const group = this.#group(input.groupId);
          const editable = group.builtin ? denied("immutable-everyone") : allowed;
          return {
            ...this.#groupSummary(group),
            directMembers: page(
              group.members.map((m) => this.#subjectView(m)),
              input,
            ),
            parents: this.#groupsOf({ kind: "group", groupId: group.id }).map((g) =>
              this.#groupRef(g),
            ),
            accessRevision: this.#revision,
            can: { rename: editable, editMembers: editable, delete: editable },
          };
        })(),
      "team.project.access.get": (input) =>
        run("team.project.access.get", () => this.#projectAccess(input.workspaceId))(),
      "team.access.explain": (input) =>
        run("team.access.explain", () => this.#explain(input.workspaceId, input.subject))(),
      "team.access.preview": (input) =>
        run("team.access.preview", () => this.#preview(input.expectedRevision, input.changes))(),
      "team.member.preview": (input) =>
        run("team.member.preview", () => this.#memberPreview(input.userId, input.change))(),
      "team.audit.list": (input) =>
        run("team.audit.list", () => {
          this.#requireAdmin();
          return page(
            [
              {
                id: "sau_00000000-0000-4000-8000-0000000000f1",
                at: new Date(Date.UTC(2026, 10, 9, 10)).toISOString(),
                action: "access.mutated",
                actor: { id: maya, name: "Maya Chen" },
                target: {
                  kind: "project" as const,
                  id: mockTeamProjects.launch,
                  name: "Customer launch",
                },
                changes: [],
              },
            ],
            input,
          );
        })(),
      "team.project.settings.get": (input) =>
        run("team.project.settings.get", () => {
          this.#requireMember();
          const project = this.#project(input.workspaceId);
          if (!this.#canManage(project.id))
            throw refusal(
              "forbidden",
              "project-manage-required",
              "Only a manager can see settings.",
            );
          return {
            settings: project.settings,
            runtime:
              project.runtime === "ready"
                ? { state: "ready" as const }
                : { state: "unavailable" as const, reason: project.runtime },
            can: { edit: allowed },
          };
        })(),
      "team.project.runtimeChoices": (input) =>
        run("team.project.runtimeChoices", () => {
          this.#requireMember();
          if (!this.#canManage(this.#project(input.workspaceId).id))
            throw refusal(
              "forbidden",
              "project-manage-required",
              "Only a manager can choose the engine.",
            );
          return {
            instances: [
              {
                id: claudeInstance,
                driverKind: HarnessIdSchema.parse("claude"),
                name: "Claude Code",
                models: [
                  { modelId: "claude-sonnet-5", options: {}, providerId: "anthropic" },
                  { modelId: "claude-opus-5", options: {}, providerId: "anthropic" },
                ].map((m) => ModelSelectionSchema.parse(m)),
              },
              {
                id: codexInstance,
                driverKind: HarnessIdSchema.parse("codex"),
                name: "Codex",
                models: [
                  { modelId: "gpt-5.6-sol", options: {}, providerId: "openai" },
                  { modelId: "gpt-5.6-terra", options: {}, providerId: "openai" },
                ].map((m) => ModelSelectionSchema.parse(m)),
              },
            ],
            revision: "runtime-choices-1",
          };
        })(),
      "team.invitation.preview": (input) =>
        run("team.invitation.preview", () => this.#invitePreview(input.selector))(),
      "team.invitation.exchange": (input) =>
        run("team.invitation.exchange", () => {
          const invitation = this.#invitations.get(input.selector);
          if (!invitation || invitation.tokenHash !== digest(input.verifier))
            return { preview: { state: "unavailable" as const } };
          this.#proof = input.selector;
          return { preview: this.#invitePreview(input.selector) };
        })(),
      "team.invitation.accept": () =>
        run("team.invitation.accept", () => {
          const invitation = this.#proof ? this.#invitations.get(this.#proof) : undefined;
          if (!invitation || invitation.revoked || invitation.accepted || this.#admitted)
            throw refusal("conflict", "invite-unavailable", "This invite can't be used.");
          invitation.accepted = true;
          this.#admitted = true;
          const id = userId("a9");
          const p: Person = {
            id,
            name: invitation.email.split("@")[0]!.replace(/^./u, (c) => c.toUpperCase()),
            email: invitation.email,
            kind: invitation.kind,
            state: "active",
            administrator: false,
            joinedAt: this.#now().toISOString(),
            invitedBy: { id: viewerId, name: "Alex Rivera" },
            connections: [],
            work: { sessions: 1, activeRuns: 0, pendingRequests: 0, pendingInputs: 0 },
          };
          this.#people.set(id, p);
          this.#syncEveryone();
          this.#bump();
          return { member: this.#memberSummary(p), accessRevision: this.#revision };
        })(),
    };
  }

  #groupSummary(group: Group) {
    return {
      ...this.#groupRef(group),
      directCount: group.members.length,
      effectivePeopleCount: this.#peopleOf({ kind: "group", groupId: group.id }).size,
      parentCount: this.#groupsOf({ kind: "group", groupId: group.id }).length,
    };
  }
}
