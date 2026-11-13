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
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { MobileTeam, MobileTeams, MobileTeamsSnapshot } from "./mobile-teams.js";
import { memberDirectory, type MemberDirectory } from "./team-views.js";

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
  return useTeamsSnapshot().teams.find((team) => team.teamId === teamId) ?? null;
}

const emptySnapshot: TeamSessionSnapshot = {
  agentRecipients: [],
  bootstrap: null,
  sidebar: null,
  channel: null,
  thread: null,
  connection: "offline",
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
  readonly failure: string | null;
} {
  const teams = useMobileTeams();
  const team = useTeam(teamId);
  const [failure, setFailure] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void teams.select(teamId);
      void teams.session(teamId).then(
        () => current && setFailure(null),
        (error: unknown) =>
          current && setFailure(error instanceof Error ? error.message : "The team didn't answer."),
      );
      return () => {
        current = false;
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
  return { team, session, snapshot, failure: failure ?? team?.detail ?? null };
}

/** The team's people, for names, faces, handles and the @ list. */
export function useTeamMembers(teamId: string): {
  readonly members: readonly TeamMember[];
  readonly directory: MemberDirectory;
  /** Whether `members` has been read yet, so an empty list can be told from one not read. */
  readonly status: "reading" | "read" | "failed";
  /** The list didn't load; `members` holds what was read before, if anything. */
  readonly failure: string | null;
  /** Reads the list again from the team, as after changing someone's role. */
  readonly reload: () => void;
} {
  const teams = useMobileTeams();
  const [read, setRead] = useState<{
    readonly members: readonly TeamMember[];
    readonly status: "reading" | "read" | "failed";
    readonly failure: string | null;
  }>({ members: [], status: "reading", failure: null });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    void teams.members(teamId).then(
      (people) => current && setRead({ members: people, status: "read", failure: null }),
      (error: unknown) =>
        current &&
        setRead((held) => ({
          members: held.members,
          status: held.status === "read" ? "read" : "failed",
          failure: error instanceof Error ? error.message : "The team didn't answer.",
        })),
    );
    return () => {
      current = false;
    };
  }, [generation, teamId, teams]);
  const reload = useCallback(() => {
    teams.forgetMembers(teamId);
    setGeneration((next) => next + 1);
  }, [teamId, teams]);
  const directory = useMemo(() => memberDirectory(read.members), [read.members]);
  return {
    members: read.members,
    directory,
    status: read.status,
    failure: read.failure,
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
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (session === null) return;
    for (const message of messages) {
      for (const file of message.attachments) {
        if (file.preview === null || asked.current.has(file.id)) continue;
        asked.current.add(file.id);
        void session
          .file(file)
          .then((blob) => (blob === null ? null : dataUri(blob)))
          .then(
            (uri) => {
              if (uri !== null) setPreviews((held) => new Map(held).set(file.id, uri));
            },
            () => asked.current.delete(file.id),
          );
      }
    }
  }, [messages, session]);
  return previews;
}

/** A Blob the platform made, as something an Image can draw. */
export function dataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
}
