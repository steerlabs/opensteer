import { useEffect, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { TeamAccess, type TeamSummaryView } from "../host/team-access.js";
import { useHostSelector } from "./use-host-snapshot.js";

export interface TeamState {
  /** Null until the Host offers team administration; nothing team-shaped renders before then. */
  readonly team: TeamAccess | null;
  readonly summary: TeamSummaryView | null;
  readonly error: unknown;
  readonly loading: boolean;
  /** Bumps after every committed team command, so a screen's own reads can key on it. */
  readonly generation: number;
  readonly refresh: () => void;
}

interface Resource {
  readonly team: TeamAccess;
  state: Omit<TeamState, "team" | "refresh">;
  readonly listeners: Set<() => void>;
  read: number;
  started: boolean;
}

const resources = new WeakMap<HostClient, Resource>();
const idle: Omit<TeamState, "team" | "refresh"> = {
  summary: null,
  error: null,
  loading: false,
  generation: 0,
};

function resourceFor(client: HostClient): Resource {
  let resource = resources.get(client);
  if (resource) return resource;
  const created: Resource = {
    team: new TeamAccess(client),
    state: { ...idle, loading: true },
    listeners: new Set(),
    read: 0,
    started: false,
  };
  created.team.onChange(() => {
    created.state = { ...created.state, generation: created.state.generation + 1 };
    void load(created);
  });
  resources.set(client, created);
  return created;
}

function publish(resource: Resource, patch: Partial<Resource["state"]>) {
  resource.state = { ...resource.state, ...patch };
  for (const listener of resource.listeners) listener();
}

async function load(resource: Resource) {
  const read = ++resource.read;
  publish(resource, { loading: true });
  try {
    const summary = await resource.team.summary();
    if (read === resource.read) publish(resource, { summary, error: null, loading: false });
  } catch (error) {
    if (read === resource.read) publish(resource, { error, loading: false });
  }
}

const noSubscribe = () => () => {};
const noState = () => idle;

/**
 * The team this Host is, read once after the first screen and shared by every
 * team screen. A Host without `team-administration-v1` gets no read at all.
 */
export function useTeam(client: HostClient): TeamState {
  const available = useHostSelector(
    client,
    (snapshot) =>
      snapshot.teamAdministrationAvailable === true && snapshot.session === "authenticated",
  );
  const resource = available ? resourceFor(client) : null;
  const state = useSyncExternalStore(
    resource
      ? (listener) => {
          resource.listeners.add(listener);
          return () => resource.listeners.delete(listener);
        }
      : noSubscribe,
    resource ? () => resource.state : noState,
    resource ? () => resource.state : noState,
  );
  useEffect(() => {
    if (!resource || resource.started) return;
    resource.started = true;
    void load(resource);
  }, [resource]);
  return {
    ...state,
    team: resource?.team ?? null,
    refresh: () => {
      if (resource) void load(resource);
    },
  };
}
