import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { ThreadIdSchema, teamPageUrl, type TeamPageLink, type ThreadId } from "@opensteer/core";
import { automationPath, type HostClient } from "@opensteer/client/host";
import {
  teamPageTarget,
  type FileOpenInput,
  type PersonalReferenceNavigationPorts,
  type ReferenceDestination,
  type ReferenceNavigationPorts,
  type ReferenceRenderContext,
} from "@opensteer/client/references";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { useTeams, type TeamAttachment } from "../../team/team-attachments.js";
import { teamPagePath } from "../../team/team-paths.js";
import { useAreaNavigate } from "../workspace/area-link.js";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";
import { FileViewer } from "./file-viewer.js";

/**
 * Whose words a chip sits in, and how it opens what it names. A personal
 * Opensteer's chips open its tasks, Runs and files; a team's open only team
 * pages, so a personal reference quoted there stays words.
 */
export type ReferenceScope =
  | {
      readonly context: Extract<ReferenceRenderContext, { kind: "personal" }>;
      readonly navigation: PersonalReferenceNavigationPorts;
    }
  | {
      readonly context: Extract<ReferenceRenderContext, { kind: "team" }>;
      readonly navigation: ReferenceNavigationPorts;
    };

export type PersonalReferenceScope = Extract<ReferenceScope, { context: { kind: "personal" } }>;

export function isPersonalScope(scope: ReferenceScope | null): scope is PersonalReferenceScope {
  return scope?.context.kind === "personal";
}

const ReferenceScopeContext = createContext<ReferenceScope | null>(null);

export function useReferenceScope(): ReferenceScope | null {
  return useContext(ReferenceScopeContext);
}

export function ReferenceNavigationProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: ReferenceScope;
}) {
  return <ReferenceScopeContext value={value}>{children}</ReferenceScopeContext>;
}

/** The attached team session for a page's origin, where this surface holds one. */
export function attachedTeam(
  teams: readonly TeamAttachment[],
  page: TeamPageLink,
): TeamAttachment | null {
  return teams.find((team) => team.origin === page.origin && team.client !== null) ?? null;
}

/**
 * A team page opens in this app where it holds that team's session (desktop,
 * the team's own web app), and otherwise at the team's own address, never as
 * a browsing tab of the agent's.
 */
export function useOpenTeamPage(): (page: TeamPageLink) => Promise<void> {
  const { teams } = useTeams();
  const navigate = useNavigate();
  return useCallback(
    async (page) => {
      const team = attachedTeam(teams, page);
      const target = teamPageTarget(page);
      if (team && target) {
        void navigate(teamPagePath(team.teamId, target));
        return;
      }
      openOutside(teamPageUrl(page));
    },
    [navigate, teams],
  );
}

export function openOutside(url: string): void {
  const bridge = desktopBridge();
  if (bridge) void bridge.openExternalUrl({ url }).catch(globalThis.reportError);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Where a personal reference leads. A message, Run or Request opens its task
 * at that point; the task finds it there, or says it isn't available.
 */
export function useOpenPersonalDestination(
  openFile: (input: FileOpenInput) => Promise<void>,
): (destination: ReferenceDestination) => Promise<void> {
  const nav = useOptionalWorkspace()?.nav ?? null;
  const navigate = useNavigate();
  const openPage = useAreaNavigate();
  return useCallback(
    async (destination) => {
      const conversation = (
        threadId: string,
        options: { readonly messageId?: string; readonly query?: Record<string, string> } = {},
      ) => {
        const path = `/tasks/${encodeURIComponent(threadId)}`;
        const query = new URLSearchParams(options.query);
        if (nav) {
          nav.openConversation(
            query.size ? `${path}?${query}` : path,
            options.messageId ? { messageId: options.messageId } : {},
          );
          return;
        }
        if (options.messageId) query.set("messageId", options.messageId);
        void navigate(query.size ? `${path}?${query}` : path);
      };
      switch (destination.kind) {
        case "task":
          return conversation(destination.threadId);
        case "message":
          return conversation(destination.threadId, { messageId: destination.messageId });
        case "run":
          return conversation(destination.threadId, {
            messageId: destination.anchorMessageId,
            query: { runId: destination.runId },
          });
        case "request":
          return conversation(destination.threadId, {
            query: { requestId: destination.requestId },
          });
        case "automation":
          return openPage(automationPath(destination.triggerId));
        case "computer":
          return void navigate(`/settings/devices/${encodeURIComponent(destination.runnerId)}`);
        case "attachment":
          return openFile({
            source: { kind: "attachment", attachmentId: destination.attachmentId },
          });
        case "tab":
          if (nav) return nav.showPlace({ kind: "tab", tabId: destination.tabId });
          return void navigate(`/?panel=browser&tab=${encodeURIComponent(destination.tabId)}`);
      }
    },
    [nav, navigate, openFile, openPage],
  );
}

/**
 * Personal reference context for everything under it: one Deployment's
 * client, the task its words belong to, and the file viewer they open.
 */
export function PersonalReferences({
  children,
  client,
  threadId,
}: {
  readonly children: ReactNode;
  readonly client: HostClient;
  readonly threadId: string | null;
}) {
  const deploymentId = useSyncExternalStore(
    client.subscribe,
    () => client.getSnapshot().deploymentId ?? "",
    () => client.getSnapshot().deploymentId ?? "",
  );
  const parsedThreadId = threadId === null ? null : ThreadIdSchema.safeParse(threadId);
  const ownThreadId = parsedThreadId?.success ? parsedThreadId.data : null;
  const [file, setFile] = useState<{
    readonly input: FileOpenInput;
    readonly threadId: ThreadId | null;
  } | null>(null);
  // A file named in these words is read as this task's; an attachment reference may be another's.
  const openFile = useCallback(
    async (input: FileOpenInput) => setFile({ input, threadId: ownThreadId }),
    [ownThreadId],
  );
  const openAttachment = useCallback(
    async (input: FileOpenInput) => setFile({ input, threadId: null }),
    [],
  );
  const openReference = useOpenPersonalDestination(openAttachment);
  const openTeamPage = useOpenTeamPage();
  const value = useMemo<ReferenceScope>(
    () => ({
      context: { kind: "personal", client, deploymentId, threadId: ownThreadId },
      navigation: { openFile, openReference, openTeamPage },
    }),
    [client, deploymentId, ownThreadId, openFile, openReference, openTeamPage],
  );
  return (
    <ReferenceScopeContext value={value}>
      {children}
      {file ? (
        <FileViewer
          client={client}
          input={file.input}
          onClose={() => setFile(null)}
          threadId={file.threadId}
        />
      ) : null}
    </ReferenceScopeContext>
  );
}

/** Team reference context: chips to this team's pages open in it; personal ones stay words. */
export function TeamReferences({
  children,
  team,
}: {
  readonly children: ReactNode;
  readonly team: Pick<TeamAttachment, "client" | "origin" | "teamId"> | null;
}) {
  const openTeamPage = useOpenTeamPage();
  const value = useMemo<ReferenceScope | null>(
    () =>
      team
        ? {
            context: {
              kind: "team",
              client: team.client,
              origin: team.origin,
              teamId: team.teamId,
            },
            navigation: {
              openReference: async () => undefined,
              openTeamPage,
            },
          }
        : null,
    [team?.client, team?.origin, team?.teamId, openTeamPage],
  );
  return <ReferenceScopeContext value={value}>{children}</ReferenceScopeContext>;
}
