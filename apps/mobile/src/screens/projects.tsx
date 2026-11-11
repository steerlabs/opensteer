import {
  canRespondToRequests,
  folderSignalWords,
  groupTasksByProject,
  isTeamPlace,
  projectStatusLabel,
  sameStableHostSnapshot,
  taskList,
  type HostClient,
  type ProjectFolder,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { headerActions, useSidebarMenu } from "../navigation-header.js";
import { color, radius, space } from "../theme.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { NeedsYouTag, UnreadDot } from "../threads/task-row.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useCanCreateProject } from "../team/team-parts.js";

export type ProjectsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Projects: this Deployment's project Workspaces, each with the one thing
 * worth knowing about it now — a folder problem, or what its work asks of
 * the reader — from the same grouping the sidebar folders read.
 *
 * Each is a place with its own files, instructions and access, not a voice
 * Chat puts on — opening one shows its own work and starts tasks inside it.
 * Nobody has to choose one to ask for something: Chat hands work to them.
 */
export function ProjectsScreen(props: ProjectsScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <ProjectDirectory deploymentId={deploymentId} hostClient={hostClient} />;
}

/** The projects, and whether a new one can be made from here right now. */
interface Directory {
  readonly canCreate: boolean;
  readonly hasMore: boolean;
  readonly loaded: boolean;
  readonly projects: readonly ProjectFolder[];
}

/**
 * A team place's root: its Projects, under the team's name. A team server has
 * no Main and no Chat, so this list is where the place opens.
 */
export function TeamHome(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const { snapshot } = useHostSnapshot(props.hostClient, sameStableHostSnapshot);
  const name = snapshot.identityConfig?.deployment.name ?? "Projects";
  useLayoutEffect(() => {
    navigation.setOptions({ headerLargeTitle: true, title: name });
  }, [name, navigation]);
  return <ProjectDirectory deploymentId={props.deploymentId} hostClient={props.hostClient} />;
}

function ProjectDirectory(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  // Streaming stamps every Workspace's activity time; none of that is shown here.
  const { loadError, snapshot } = useHostSnapshot(props.hostClient, sameStableHostSnapshot);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const { deploymentId } = props;
  const teamAllowsCreate = useCanCreateProject(props.hostClient);
  const team = isTeamPlace(snapshot);

  const directory = useMemo<Directory>(
    () => ({
      canCreate: canRespondToRequests(snapshot),
      hasMore: snapshot.workspaceWindow.hasMore,
      // A Personal place always has Main; a team place may truly have no Projects.
      loaded: snapshot.workspaces.length > 0 || (team && snapshot.deploymentId !== null),
      projects: groupTasksByProject(snapshot, taskList(snapshot)).folders,
    }),
    [snapshot, team, teamAllowsCreate],
  );

  const create = useCallback(
    () => navigation.navigate("NewProject", { deploymentId }),
    [deploymentId, navigation],
  );
  useLayoutEffect(() => {
    if (!teamAllowsCreate) {
      navigation.setOptions(headerActions({}));
      return;
    }
    navigation.setOptions(
      headerActions({
        right: {
          accessibilityLabel: directory.canCreate
            ? "New project"
            : "New project unavailable while offline",
          disabled: !directory.canCreate,
          icon: "plus",
          label: "New project",
          onPress: create,
        },
      }),
    );
  }, [create, directory.canCreate, navigation, teamAllowsCreate]);

  const open = useCallback(
    (workspaceId: string) => navigation.navigate("Project", { deploymentId, workspaceId }),
    [deploymentId, navigation],
  );

  const loadMore = (): void => {
    if (!directory.hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void props.hostClient
      .loadEarlierWorkspaces()
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "More projects could not be loaded.")),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  };

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ProjectFolder>) => <ProjectRow folder={item} onPress={open} />,
    [open],
  );

  return (
    <Screen edgeToEdge>
      <FlatList
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        data={directory.projects}
        keyExtractor={(folder) => folder.workspace.id}
        ListEmptyComponent={
          !directory.loaded && loadError === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={color.muted} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Symbol name="folder" size={30} tint={color.mutedDim} />
              <AppText role="title">No projects yet</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                {team
                  ? teamAllowsCreate
                    ? "When someone adds you to a project, it appears here. You can also start one."
                    : "When someone adds you to a project, it appears here."
                  : "Give recurring or long-running work its own folder inside Main, with its own chat, tasks, people and access. You don’t need one to ask in Chat."}
              </AppText>
              {directory.canCreate && teamAllowsCreate ? (
                <SecondaryButton compact label="New project" onPress={create} />
              ) : null}
            </View>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={color.muted} size="small" />
            </View>
          ) : undefined
        }
        ListHeaderComponent={
          loadError === null && failure === null ? undefined : (
            <Notice
              action={{
                label: "Try again",
                onPress: () => {
                  if (failure === null) {
                    void props.hostClient.refresh().catch(() => undefined);
                    return;
                  }
                  setFailure(null);
                  loadMore();
                },
              }}
              detail={failure ?? loadError ?? ""}
              title={
                failure === null
                  ? "Projects could not be read"
                  : "More projects could not be loaded"
              }
              tone="neutral"
            />
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        renderItem={renderItem}
      />
    </Screen>
  );
}

interface ProjectRowProps {
  readonly folder: ProjectFolder;
  readonly onPress: (workspaceId: string) => void;
}

const ProjectRow = memo(function ProjectRow(props: ProjectRowProps): ReactNode {
  const { workspace, signal, needsYou, rows } = props.folder;
  const problem = projectStatusLabel(workspace);
  const words = problem ?? folderSignalWords(signal, needsYou);
  const description = workspace.description.trim();
  const detail =
    description !== ""
      ? description
      : rows.length > 0
        ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"} open`
        : null;
  return (
    <Pressable
      accessibilityHint="Opens this project"
      accessibilityLabel={[workspace.name, words, detail].filter(Boolean).join(". ")}
      accessibilityRole="button"
      onPress={() => props.onPress(workspace.id)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <WorkspaceMark icon={workspace.icon} name={workspace.name} color={workspace.color} />
      <View style={styles.rowText}>
        <AppText numberOfLines={1} role="title">
          {workspace.name}
        </AppText>
        {detail === null ? null : (
          <AppText numberOfLines={2} role="secondary" tone="muted">
            {detail}
          </AppText>
        )}
        {problem === null ? null : (
          <View style={styles.problem}>
            <Symbol name="exclamationmark.circle" size={13} tint={color.amber} />
            <AppText role="caption" style={styles.status}>
              {problem}
            </AppText>
          </View>
        )}
      </View>
      {problem === null ? <FolderState folder={props.folder} /> : null}
      <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
    </Pressable>
  );
}, sameProjectRowProps);

/** What its work asks of the reader, in the sidebar folder's own marks. */
function FolderState(props: { readonly folder: ProjectFolder }): ReactNode {
  const { signal, rows } = props.folder;
  switch (signal) {
    case "needs-you":
      return <NeedsYouTag />;
    case "working": {
      const working = rows.filter((row) => row.tone === "working").length;
      return (
        <AppText role="caption" tone="ember">
          {working > 1 ? `${working} working` : "Working"}
        </AppText>
      );
    }
    case "failed":
      return (
        <AppText role="caption" tone="danger">
          Couldn’t finish
        </AppText>
      );
    case "unread":
      return <UnreadDot />;
    case null:
      return null;
  }
}

function sameProjectRowProps(left: ProjectRowProps, right: ProjectRowProps): boolean {
  const a = left.folder;
  const b = right.folder;
  return (
    left.onPress === right.onPress &&
    a.workspace.id === b.workspace.id &&
    a.workspace.name === b.workspace.name &&
    a.workspace.description === b.workspace.description &&
    a.workspace.icon === b.workspace.icon &&
    a.workspace.color === b.workspace.color &&
    a.workspace.status === b.workspace.status &&
    a.workspace.storageIssue === b.workspace.storageIssue &&
    a.signal === b.signal &&
    a.needsYou === b.needsYou &&
    a.rows.length === b.rows.length &&
    a.rows.filter((row) => row.tone === "working").length ===
      b.rows.filter((row) => row.tone === "working").length
  );
}

const styles = StyleSheet.create({
  centred: { textAlign: "center" },
  content: { gap: space[2], paddingTop: space[8] },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[48],
  },
  footer: { paddingVertical: space[16] },
  loading: { alignItems: "center", paddingVertical: space[48] },
  pressed: { backgroundColor: color.surfacePressed },
  problem: { alignItems: "center", flexDirection: "row", gap: space[4] },
  row: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[14],
    marginHorizontal: -space[8],
    minHeight: 64,
    paddingHorizontal: space[8],
    paddingVertical: space[12],
  },
  rowText: { flex: 1, gap: space[2], minWidth: 0 },
  status: { color: color.amber },
});
