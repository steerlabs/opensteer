import { useEffect, useSyncExternalStore } from "react";
import type { TeamMember } from "@opensteer/protocol";
import type { TeamSessionClient } from "@opensteer/client/team";
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

export function personView(member: TeamMember, viewerUserId: string | null): PersonView {
  return {
    id: member.userId,
    name: member.displayName,
    handle: member.handle,
    tint: tintOf(member.userId),
    avatarUrl: member.image,
    you: member.userId === viewerUserId,
  };
}

export function unknownPerson(userId: string): PersonView {
  return { id: userId, name: "Someone", handle: "someone", tint: tintOf(userId) };
}

interface PeopleState {
  readonly members: ReadonlyMap<string, TeamMember>;
  readonly loading: boolean;
}

/** One team's member directory, read page by page once and again after an access change. */
class TeamPeople {
  readonly #client: TeamSessionClient;
  readonly #listeners = new Set<() => void>();
  #state: PeopleState = { members: new Map(), loading: false };
  #load = 0;
  #revision: string | null = null;

  constructor(client: TeamSessionClient) {
    this.#client = client;
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
    this.#set({ loading: true });
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
      this.#set({ members, loading: false });
    })().catch(() => {
      if (load === this.#load) this.#set({ loading: false });
    });
  }

  #set(patch: Partial<PeopleState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
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

const empty: PeopleState = { members: new Map(), loading: false };
const noSubscribe = () => () => {};

/** The team's members by user id, kept fresh with its access revision. */
export function useTeamMembers(
  client: TeamSessionClient | null,
  revision: string | null,
): ReadonlyMap<string, TeamMember> {
  const people = client ? directoryOf(client) : null;
  useEffect(() => {
    if (revision !== null) people?.refresh(revision);
  }, [people, revision]);
  return useSyncExternalStore(
    people?.subscribe ?? noSubscribe,
    () => people?.getState() ?? empty,
    () => people?.getState() ?? empty,
  ).members;
}
