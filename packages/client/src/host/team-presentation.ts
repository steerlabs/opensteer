import {
  TeamReasonSchema,
  type AccessExplanation,
  type AccessPreview,
  type EntryView,
  type GroupRef,
  type Level,
  type MemberChange,
  type MemberKind,
  type MemberPreview,
  type MemberState,
  type RuntimeState,
  type TeamReason,
} from "@opensteer/protocol";
import { HostClientRequestError } from "./client.js";

export function levelLabel(level: Level): string {
  return level === "manage" ? "Can manage" : "Can use";
}

export function memberKindLabel(kind: MemberKind, administrator = false): string {
  if (administrator) return "Admin";
  return kind === "guest" ? "Guest" : "Member";
}

export function memberStateLabel(state: MemberState): string {
  if (state === "suspended") return "Suspended";
  if (state === "removed") return "Removed";
  return "Active";
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0]![0], words.at(-1)![0]] : [words[0]?.[0]];
  return letters.join("").toLocaleUpperCase() || "?";
}

/** One plain sentence for each reason the Host gives. */
export function teamReasonText(reason: TeamReason, team = "the team"): string {
  switch (reason) {
    case "team-unavailable":
      return "Team administration isn’t available here.";
    case "human-session-required":
      return "Only a person signed in here can do this. Connected agents can’t.";
    case "team-admin-required":
      return `Only an admin of ${team} can do this.`;
    case "project-manage-required":
      return "Only someone who can manage this project can do this.";
    case "member-suspended":
      return `Your access to ${team} is paused. Ask an admin to turn it back on.`;
    case "member-removed":
      return `You’re no longer in ${team}.`;
    case "membership-lost":
      return "You no longer have access to this project.";
    case "connection-revoked":
      return "This connection was ended.";
    case "sign-in-required":
      return "Sign in again to continue.";
    case "member-generation-changed":
      return "Your access changed. Sign in again to continue.";
    case "team-object-unavailable":
      return "This isn’t available. It may have been removed, or it isn’t visible to you.";
    case "access-revision-changed":
      return "Someone changed access just now. Review the change again before you save it.";
    case "last-active-admin":
      return `${team} needs at least one admin.`;
    case "immutable-everyone":
      return "Everyone always holds every member, so it can’t be changed.";
    case "invite-unavailable":
      return "This invite can’t be used. Ask an admin for a new one.";
    case "idempotency-conflict":
      return "This change was already sent with different details. Start it again.";
    case "settings-revision-changed":
      return "Someone changed these settings just now. Review them again before you save.";
    case "access-cycle":
      return "That would put a group inside itself.";
    case "access-depth":
      return "Groups can’t be nested that deeply.";
    case "invalid-subject":
      return "That person or group isn’t in the team.";
    case "invalid-level":
      return "That level isn’t available here.";
    case "unsupported-target":
      return "Access can’t be given to that.";
    case "invalid-selection":
      return "That engine and model don’t go together. Choose them again.";
    case "access-capacity":
      return "This would go past the team’s access limit.";
  }
}

export function teamReasonOf(error: unknown): TeamReason | null {
  if (!(error instanceof HostClientRequestError) || !error.reason) return null;
  const parsed = TeamReasonSchema.safeParse(error.reason);
  return parsed.success ? parsed.data : null;
}

/** Revision conflicts are the only refusals worth reading again and retrying. */
export function teamErrorIsStale(error: unknown): boolean {
  const reason = teamReasonOf(error);
  return reason === "access-revision-changed" || reason === "settings-revision-changed";
}

export function teamErrorText(error: unknown, team?: string): string {
  const reason = teamReasonOf(error);
  if (reason) return teamReasonText(reason, team);
  if (error instanceof HostClientRequestError && error.message) return error.message;
  return "The team server couldn’t be reached. Try again.";
}

export function peopleCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

export interface AccessPreviewLine {
  readonly tone: "gain" | "lose" | "change" | "keep" | "blocked";
  readonly text: string;
}

/** What a previewed access change does, in words, from the Host's own names. */
export function accessPreviewLines(preview: AccessPreview, team?: string): AccessPreviewLine[] {
  if (!preview.allowed)
    return [...new Set(preview.blockers.map(({ reason }) => teamReasonText(reason, team)))].map(
      (text) => ({ tone: "blocked", text }),
    );
  const lines: AccessPreviewLine[] = preview.changes.map(({ user, before, after }) => {
    if (before === null && after !== null)
      return { tone: "gain", text: `${user.name} gets ${levelLabel(after)}` };
    if (after === null && before !== null)
      return {
        tone: "lose",
        text: `${user.name} loses access (${levelLabel(before).toLocaleLowerCase()})`,
      };
    return {
      tone: "change",
      text: `${user.name}: ${levelLabel(before ?? "use")} → ${levelLabel(after ?? "use")}`,
    };
  });
  for (const keep of preview.surviving) {
    lines.push({
      tone: "keep",
      text: `${keep.name} keeps ${levelLabel(keep.level)} another way`,
    });
  }
  if (preview.truncated) {
    const shown = preview.changes.length;
    const total =
      preview.counts.peopleGaining + preview.counts.peopleLosing + preview.counts.levelChanges;
    if (total > shown) lines.push({ tone: "change", text: `And ${total - shown} more` });
  }
  return lines;
}

export function accessPreviewHeadline(preview: AccessPreview): string {
  const { peopleGaining, peopleLosing, levelChanges } = preview.counts;
  const parts = [
    peopleGaining ? `${peopleCount(peopleGaining)} gain access` : null,
    peopleLosing ? `${peopleCount(peopleLosing)} lose access` : null,
    levelChanges ? `${peopleCount(levelChanges)} change level` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? `${parts.join(", ")}.` : "Nobody’s access changes.";
}

export interface MemberPreviewCopy {
  readonly title: string;
  readonly ends: readonly string[];
  readonly carriesOn: readonly string[];
  readonly after: string;
  readonly confirm: string;
}

/** The consequences of a person change, from the Host's counts. */
export function memberPreviewCopy(
  name: string,
  change: MemberChange,
  preview: MemberPreview,
  team: string,
): MemberPreviewCopy {
  const { sessions, connections, activeRuns, pendingRequests, pendingInputs } = preview.counts;
  const work = [
    sessions ? `${name}’s ${sessions === 1 ? "sign-in" : `${sessions} sign-ins`} to ${team}` : null,
    connections
      ? `${connections === 1 ? "1 connected agent" : `${connections} connected agents`} acting for ${name}`
      : null,
    activeRuns
      ? `${activeRuns === 1 ? "1 running task" : `${activeRuns} running tasks`} ${name} started`
      : null,
    pendingRequests
      ? `${pendingRequests === 1 ? "1 waiting question" : `${pendingRequests} waiting questions`} for ${name}`
      : null,
    pendingInputs
      ? `${pendingInputs === 1 ? "1 queued message" : `${pendingInputs} queued messages`} from ${name}`
      : null,
  ].filter((line): line is string => line !== null);
  const projects = [
    preview.projectsLosing
      ? `Access to ${preview.projectsLosing === 1 ? "1 project" : `${preview.projectsLosing} projects`}`
      : null,
    preview.projectsChangingLevel
      ? `${preview.projectsChangingLevel === 1 ? "1 project changes" : `${preview.projectsChangingLevel} projects change`} level`
      : null,
  ].filter((line): line is string => line !== null);
  const carriesOn = [
    `Projects, files and schedules ${name} made`,
    `${name}’s own Opensteer, chats and accounts. ${team} can’t reach those.`,
  ];
  switch (change.kind) {
    case "set-state":
      if (change.value === "active")
        return {
          title: `Turn ${name} back on?`,
          ends: projects,
          carriesOn: [],
          after: `${name} signs in again to use ${team}. Nothing that ended comes back by itself.`,
          confirm: "Turn back on",
        };
      if (change.value === "removed")
        return {
          title: `Remove ${name} from ${team}?`,
          ends: [...work, ...projects],
          carriesOn,
          after: `${name} leaves every group and project. The audit log keeps ${name}’s history. To return, ${name} needs a new invite.`,
          confirm: `Remove ${name}`,
        };
      return {
        title: `Suspend ${name}?`,
        ends: [...work, ...projects],
        carriesOn,
        after: `You can turn ${name} back on later. Nothing that ended comes back; ${name} signs in again.`,
        confirm: "Suspend",
      };
    case "set-administrator":
      return change.value
        ? {
            title: `Make ${name} an admin?`,
            ends: work.length
              ? [`${name}’s current sign-ins, so they sign in again as an admin`]
              : [],
            carriesOn: [],
            after: `${name} can manage people, groups and every project’s access list. Admins see who is on a project, not its chats or files.`,
            confirm: "Make admin",
          }
        : {
            title: `Remove ${name} as admin?`,
            ends: work.length
              ? [`${name}’s current sign-ins, so they sign in again as a member`]
              : [],
            carriesOn: [`${name} stays in ${team} with the access they have`],
            after: `${name} can no longer manage people or groups.`,
            confirm: "Remove as admin",
          };
    case "set-kind":
      return change.value === "guest"
        ? {
            title: `Make ${name} a guest?`,
            ends: projects,
            carriesOn: [`Projects ${name} was added to directly or through a group`],
            after: `Guests aren’t in Everyone, so projects shared with Everyone stop including ${name}.`,
            confirm: "Make guest",
          }
        : {
            title: `Make ${name} a member?`,
            ends: [],
            carriesOn: [],
            after: `Members are in Everyone, so ${name} gets every project shared with Everyone.`,
            confirm: "Make member",
          };
  }
}

export function runtimeStateText(state: RuntimeState): string | null {
  if (state.state === "ready") return null;
  switch (state.reason) {
    case "not-configured":
      return "Choose an engine and model before this project can run tasks.";
    case "computer-offline":
      return "The team’s computer is offline, so tasks wait until it’s back.";
    case "engine-unavailable":
      return "The chosen engine isn’t available on the team’s computer. Choose another.";
    case "model-unavailable":
      return "The chosen model isn’t available any more. Choose another.";
    case "runner-update-required":
      return "The team’s computer needs an update before it can run tasks.";
  }
}

/**
 * Why a Project can't run tasks, for someone who can use but not change it,
 * and who can fix it. Null when it runs.
 */
export function runtimeStateForUser(
  state: RuntimeState,
  managers: readonly { readonly name: string }[],
  team = "the team",
): { readonly why: string; readonly fix: string } | null {
  if (state.state === "ready") return null;
  const why = {
    "not-configured": "It hasn’t been set up to run tasks yet.",
    "computer-offline": `${team}’s computer is offline, so tasks wait until it’s back.`,
    "engine-unavailable": `Its engine isn’t available on ${team}’s computer.`,
    "model-unavailable": "The model it was set up with isn’t available any more.",
    "runner-update-required": `${team}’s computer needs an update before it can run tasks.`,
  }[state.reason];
  const names = managers.map(({ name }) => name);
  const fix =
    state.reason === "computer-offline" || state.reason === "runner-update-required"
      ? `An admin of ${team} can fix this.`
      : names.length === 0
        ? `It has no manager yet. Ask an admin of ${team} to appoint one.`
        : `${listNames(names)} can fix this: they manage it.`;
  return { why, fix };
}

function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, 2).join(", ")} or another manager`;
}

export interface AccessPath {
  readonly entry: EntryView;
  /** Groups from the person outward: the person is in via[0], which is in via[1]… */
  readonly via: readonly GroupRef[];
}

/**
 * The ways a subject reaches a Project, read from the Host's explanation
 * graph. Higher levels first, then shorter paths. Bounded, because nesting
 * can make many paths from few edges.
 */
export function accessPaths(explanation: AccessExplanation, limit = 12): AccessPath[] {
  const groups = new Map(explanation.groups.map((group) => [group.id, group]));
  const parents = new Map<string, string[]>();
  for (const edge of explanation.edges) {
    const key =
      edge.member.kind === "person"
        ? `person:${edge.member.userId}`
        : `group:${edge.member.groupId}`;
    parents.set(key, [...(parents.get(key) ?? []), edge.groupId]);
  }
  const start =
    explanation.subject.kind === "person"
      ? `person:${explanation.subject.userId}`
      : `group:${explanation.subject.groupId}`;
  const routes = new Map<string, string[][]>();
  let budget = 2048;
  const walk = (node: string, route: string[]) => {
    if (budget-- <= 0) return;
    const known = routes.get(node) ?? [];
    if (known.length >= limit) return;
    routes.set(node, [...known, route]);
    for (const parent of parents.get(node) ?? [])
      if (!route.includes(parent)) walk(`group:${parent}`, [...route, parent]);
  };
  walk(start, []);
  const paths: AccessPath[] = [];
  for (const entry of explanation.entries) {
    if (entry.revokedAt !== null) continue;
    const key =
      entry.subject.kind === "person"
        ? `person:${entry.subject.userId}`
        : `group:${entry.subject.groupId}`;
    for (const route of routes.get(key) ?? []) {
      paths.push({
        entry,
        via: route.map((id) => groups.get(id) ?? { id, name: "A group", builtin: null }),
      });
    }
  }
  return paths
    .sort(
      (a, b) =>
        Number(b.entry.level === "manage") - Number(a.entry.level === "manage") ||
        a.via.length - b.via.length,
    )
    .slice(0, limit);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
    new Date(value),
  );
}

/** One way in, as a sentence: directly, or through a chain of groups. */
export function accessPathSentence(name: string, { entry, via }: AccessPath): string {
  const level = levelLabel(entry.level);
  const when = shortDay(entry.grantedAt);
  if (via.length === 0) return `Added directly by ${entry.grantedBy.name}, ${when} (${level}).`;
  const chain = via.map((group, index) =>
    index === 0 ? `${name} is in ${group.name}` : `which is in ${group.name}`,
  );
  return `${chain.join(", ")}. ${entry.grantedBy.name} added ${via.at(-1)!.name}, ${when} (${level}).`;
}
