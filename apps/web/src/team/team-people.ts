import type { TeamPerson } from "@opensteer/client/team";
import { useEffect, useSyncExternalStore } from "react";
import type { TeamMember } from "@opensteer/protocol";
import type { TeamSessionClient, TeamSessionSnapshot } from "@opensteer/client/team";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { PersonView, TeamTileView } from "../components/team/team-models.js";

/** Enough members to name every author in a team this app serves; past it, rows read "Someone". */
const memberBound = 1000;
const tints = ["#d4704f", "#5aa06a", "#4f7fd4", "#a35fc9", "#c9a23f", "#3fa3a3", "#c95f7f"];

function tintOf(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return tints[Math.abs(hash) % tints.length]!;
}

export function teamTile(teamId: string, name: string): TeamTileView {
  return { name, color: tintOf(teamId) };
}

export function personView(member: TeamPerson, viewerUserId: string | null): PersonView {
  return {
    id: member.userId,
    name: member.displayName,
    handle: member.handle,
    tint: tintOf(member.userId),
    avatarUrl: member.image,
    ...(member.externalTeam ? { externalTeam: member.externalTeam } : {}),
    you: member.userId === viewerUserId,
  };
}

export function unknownPerson(userId: string): PersonView {
  return { id: userId, name: "Someone", handle: "someone", tint: tintOf(userId) };
}

export interface PeopleState {
  readonly members: ReadonlyMap<string, TeamMember>;
  /** Whether the directory has been read yet; a failed reread keeps the people last read. */
  readonly status: "reading" | "read" | "failed";
}

/**
 * One team's member directory, read page by page once and again after an access change, with
 * renames the team announces laid over it as they arrive.
 */
class TeamPeople {
  readonly #client: TeamSessionClient;
  readonly #listeners = new Set<() => void>();
  #state: PeopleState = { members: new Map(), status: "reading" };
  #load = 0;
  #revision: string | null = null;
  #updates: TeamSessionSnapshot["memberUpdates"];

  constructor(client: TeamSessionClient) {
    this.#client = client;
    client.subscribe(() => this.#applyUpdates());
  }

  #applyUpdates(): void {
    const updates = this.#client.getSnapshot().memberUpdates;
    if (updates === this.#updates) return;
    this.#updates = updates;
    if (!updates || this.#state.members.size === 0) return;
    const members = withNewerNames(this.#state.members, updates);
    if (members !== this.#state.members) this.#set({ members });
  }

  getState = (): PeopleState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads the directory when the team's access revision moved past the one it was read at. */
  refresh(revision: string | null): void {
    if (revision !== null && revision === this.#revision) return;
    this.#revision = revision;
    const load = ++this.#load;
    void (async () => {
      const members = new Map<string, TeamMember>();
      let after: string | undefined;
      do {
        const page = unwrapRpcResult(
          await this.#client.rpc["team.members.list"](after ? { after } : {}),
        );
        if (load !== this.#load) return;
        for (const member of page.members) members.set(member.userId, member);
        after = page.hasMore ? page.members.at(-1)?.userId : undefined;
      } while (after && members.size < memberBound);
      // A rename that arrived while this read was in flight may be newer than the page.
      this.#set({
        members: withNewerNames(members, this.#client.getSnapshot().memberUpdates ?? {}),
        status: "read",
      });
    })().catch(() => {
      if (load === this.#load && this.#state.status !== "read") this.#set({ status: "failed" });
    });
  }

  #set(patch: Partial<PeopleState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Lays announced renames over a directory: only the name moves, and only forward. Role, state
 * and the rest stay as last read, which may be newer than the announcement.
 */
function withNewerNames(
  members: ReadonlyMap<string, TeamMember>,
  updates: Readonly<Record<string, TeamMember>>,
): ReadonlyMap<string, TeamMember> {
  let next: Map<string, TeamMember> | null = null;
  for (const update of Object.values(updates)) {
    const held = members.get(update.userId);
    if (!held || (update.nameRevision ?? 0) <= (held.nameRevision ?? 0)) continue;
    next ??= new Map(members);
    next.set(update.userId, {
      ...held,
      displayName: update.displayName,
      nameRevision: update.nameRevision,
    });
  }
  return next ?? members;
}

const directories = new WeakMap<TeamSessionClient, TeamPeople>();

function directoryOf(client: TeamSessionClient): TeamPeople {
  let people = directories.get(client);
  if (!people) {
    people = new TeamPeople(client);
    directories.set(client, people);
  }
  return people;
}

const empty: PeopleState = { members: new Map(), status: "reading" };
const noSubscribe = () => () => {};

/** The team's members by user id, kept fresh with its access revision. */
export function useTeamMembers(
  client: TeamSessionClient | null,
  revision: string | null,
): PeopleState {
  const people = client ? directoryOf(client) : null;
  useEffect(() => {
    if (revision !== null) people?.refresh(revision);
  }, [people, revision]);
  return useSyncExternalStore(
    people?.subscribe ?? noSubscribe,
    () => people?.getState() ?? empty,
    () => people?.getState() ?? empty,
  );
}
