import { teamPeopleDirectory } from "@opensteer/client/team";
import type {
  AccountTeamsClient,
  TeamConnectionIntent,
  TeamCoordinator,
  TeamCoordinatorSnapshot,
  TeamSessionClient,
  TeamSessionSnapshot,
} from "@opensteer/client/team";
import type { TeamMember, TeamMessage } from "@opensteer/protocol";
import { useFocusEffect } from "@react-navigation/native";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { MobileTeam, MobileTeams, MobileTeamsSnapshot } from "./mobile-teams.js";
import type { ActionLineValue } from "../ui/action-line.js";
import { readLine, useScreenRead } from "../ui/client-feedback.js";
import { publishForegroundTeams } from "./team-connection-pill.js";
import type { MemberDirectory } from "./team-views.js";

const noMembers: readonly TeamMember[] = [];

const MobileTeamsContext = createContext<MobileTeams | null>(null);

/** Creating, joining and leaving teams, and getting the person's agent into them. */
export interface TeamEntry {
  readonly coordinator: TeamCoordinator;
  readonly account: AccountTeamsClient;
}

const TeamEntryContext = createContext<TeamEntry | null>(null);

export function MobileTeamsProvider(props: {
  readonly teams: MobileTeams;
  readonly entry: TeamEntry;
  readonly children: ReactNode;
}): ReactNode {
  const { teams } = props;
  useEffect(() => {
    publishForegroundTeams(teams);
    return () => publishForegroundTeams(null);
  }, [teams]);
  return (
    <MobileTeamsContext value={props.teams}>
      <TeamEntryContext value={props.entry}>{props.children}</TeamEntryContext>
    </MobileTeamsContext>
  );
}

export function useTeamEntry(): TeamEntry {
  const entry = use(TeamEntryContext);
  if (entry === null) throw new Error("Team screens need MobileTeamsProvider.");
  return entry;
}

export function useCoordinatorSnapshot(): TeamCoordinatorSnapshot {
  const { coordinator } = useTeamEntry();
  return useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
}

/** Where getting the person's agent into one team stands on this phone, if it was asked. */
export function useAgentIntent(teamId: string): TeamConnectionIntent | null {
  return (
    useCoordinatorSnapshot().intents.find((intent) => intent.teamDeploymentId === teamId) ?? null
  );
}

export function useMobileTeams(): MobileTeams {
  const teams = use(MobileTeamsContext);
  if (teams === null) throw new Error("Team screens need MobileTeamsProvider.");
  return teams;
}

export function useTeamsSnapshot(): MobileTeamsSnapshot {
  const teams = useMobileTeams();
  return useSyncExternalStore(teams.subscribe, teams.getSnapshot, teams.getSnapshot);
}

export function useTeam(teamId: string): MobileTeam | null {
  const snapshot = useTeamsSnapshot();
  return [...snapshot.teams, ...snapshot.unlinked].find((team) => team.teamId === teamId) ?? null;
}

const emptySnapshot: TeamSessionSnapshot = {
  sendNotices: {},
  agentRecipients: [],
  bootstrap: null,
  sidebar: null,
  channel: null,
  thread: null,
  connection: "offline",
  unreachable: false,
  versionRefusal: null,
  resumedGeneration: 0,
  pending: [],
  drafts: {},
  typing: {},
  presence: {},
  search: null,
  error: null,
  ended: null,
  contentGeneration: 0,
};

/**
 * A team screen's session, with this team in front for as long as the screen
 * is: it is the one team this phone keeps a socket to.
 */
export function useTeamSession(teamId: string): {
  readonly team: MobileTeam | null;
  readonly session: TeamSessionClient | null;
  readonly snapshot: TeamSessionSnapshot;
} {
  const teams = useMobileTeams();
  const team = useTeam(teamId);
  useFocusEffect(
    useCallback(() => {
      void teams.select(teamId);
      // Its outcome shows as the team's state: the gate and the pill say it.
      void teams.session(teamId).catch(() => undefined);
      return () => {
        if (teams.getSnapshot().selected === teamId) void teams.select(null);
      };
    }, [teamId, teams]),
  );
  const session = team?.session ?? null;
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  const read = useCallback(() => session?.getSnapshot() ?? emptySnapshot, [session]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return { team, session, snapshot };
}

/** The team's people, for names, faces, handles and the @ list. */
export function useTeamMembers(
  teamId: string,
  channelId?: string,
): {
  readonly members: readonly TeamMember[];
  readonly directory: MemberDirectory;
  /** Whether `members` has been read yet, so an empty list can be told from one not read. */
  readonly status: "reading" | "read" | "failed";
  /** Only when nothing was ever read: the one line saying so, with Try again. */
  readonly line: ActionLineValue | null;
  /** Reads the list again from the team, as after changing someone's role. */
  readonly reload: () => void;
} {
  const teams = useMobileTeams();
  const session = useTeam(teamId)?.session ?? null;
  const subscribePeople = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  // The list is read again once the team's access has moved since it was read, even while this
  // screen was away. Renames arrive as the session's member updates, laid over it below.
  const read = useScreenRead<readonly TeamMember[]>(session, {
    key: `team-members:${teamId}`,
    label: "people",
    read: () => teams.members(teamId, session?.getSnapshot().sidebar?.accessRevision ?? null),
    subscribeInvalidation: (invalidate) => {
      let revision = session?.getSnapshot().sidebar?.accessRevision ?? null;
      return (
        session?.subscribe(() => {
          const next = session.getSnapshot().sidebar?.accessRevision ?? null;
          if (next === revision) return;
          revision = next;
          invalidate();
        }) ?? (() => undefined)
      );
    },
  });
  const refresh = read.refresh;
  const reload = useCallback(() => {
    teams.forgetMembers(teamId);
    refresh();
  }, [refresh, teamId, teams]);
  const held = read.data ?? noMembers;
  const readPeople = useCallback(() => {
    const snapshot = session?.getSnapshot();
    return channelId ? snapshot?.peopleByChannel?.[channelId] : snapshot?.people;
  }, [session, channelId]);
  const remotePeople = useSyncExternalStore(subscribePeople, readPeople, readPeople);
  const readHandles = useCallback(
    () => (channelId ? session?.getSnapshot().handlesByChannel?.[channelId] : undefined),
    [session, channelId],
  );
  const handles = useSyncExternalStore(subscribePeople, readHandles, readHandles);
  // Renames announced since the list was read: only the name moves, and only forward.
  const readUpdates = useCallback(() => session?.getSnapshot().memberUpdates, [session]);
  const updates = useSyncExternalStore(subscribePeople, readUpdates, readUpdates);
  const members = useMemo(
    () =>
      updates
        ? held.map((member) => {
            const renamed = updates[member.userId];
            return renamed && (renamed.nameRevision ?? 0) > (member.nameRevision ?? 0)
              ? { ...member, displayName: renamed.displayName, nameRevision: renamed.nameRevision }
              : member;
          })
        : held,
    [held, updates],
  );
  const directory = useMemo(
    () => teamPeopleDirectory(members, remotePeople, handles),
    [members, remotePeople, handles],
  );
  return {
    members,
    directory,
    status: read.status === "ready" ? "read" : read.status === "failed" ? "failed" : "reading",
    line: readLine(read, reload),
    reload,
  };
}

/**
 * The small previews of the images in view, made by whoever uploaded them.
 * Originals are read only when one is opened; a preview the team no longer
 * lets the reader see simply never appears.
 */
export function useTeamPreviews(
  session: TeamSessionClient | null,
  messages: readonly TeamMessage[],
): ReadonlyMap<string, string> {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(new Map());
  const lifetime = useMemo(() => ({ current: true, asked: new Set<string>() }), [session]);
  useEffect(() => {
    lifetime.current = true;
    setPreviews(new Map());
    return () => {
      lifetime.current = false;
    };
  }, [lifetime]);
  useEffect(() => {
    if (session === null) return;
    for (const message of messages) {
      for (const file of message.attachments) {
        if (file.preview === null || lifetime.asked.has(file.id)) continue;
        lifetime.asked.add(file.id);
        void session
          .file(file)
          .then((blob) => (blob === null ? null : dataUri(blob, session.signal)))
          .then(
            (uri) => {
              if (lifetime.current && !session.signal.aborted && uri !== null)
                setPreviews((held) => new Map(held).set(file.id, uri));
            },
            () => lifetime.asked.delete(file.id),
          );
      }
    }
  }, [messages, session, lifetime]);
  return session?.signal.aborted ? new Map() : previews;
}

/** A Blob the platform made, as something an Image can draw. */
export function dataUri(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    reader.onloadend = () => signal?.removeEventListener("abort", abort);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
}
