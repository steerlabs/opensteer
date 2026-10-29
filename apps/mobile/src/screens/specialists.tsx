import {
  canRespondToRequests,
  sameStableHostSnapshot,
  type HostClient,
  type WorkspaceSummary,
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
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { specialistStatus } from "./specialist.js";

export type SpecialistsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Specialists: this Deployment's specialized Workspaces.
 *
 * Each is a place with its own files, instructions and access, not a voice
 * Chat puts on — opening one shows its own work and starts tasks inside it.
 * Nobody has to choose one to ask for something: Chat hands work to them.
 */
export function SpecialistsScreen(props: SpecialistsScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <SpecialistDirectory deploymentId={deploymentId} hostClient={hostClient} />;
}

/** The specialists, and whether a new one can be made from here right now. */
interface Directory {
  readonly canCreate: boolean;
  readonly hasMore: boolean;
  readonly loaded: boolean;
  readonly specialists: readonly WorkspaceSummary[];
}

function SpecialistDirectory(props: {
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

  const directory = useMemo<Directory>(
    () => ({
      canCreate: canRespondToRequests(snapshot),
      hasMore: snapshot.workspaceWindow.hasMore,
      loaded: snapshot.workspaces.length > 0,
      specialists: snapshot.workspaces.filter(({ kind }) => kind === "specialized"),
    }),
    [snapshot],
  );

  const create = useCallback(
    () => navigation.navigate("NewSpecialist", { deploymentId }),
    [deploymentId, navigation],
  );
  useLayoutEffect(() => {
    navigation.setOptions(
      headerActions({
        right: {
          accessibilityLabel: directory.canCreate
            ? "New specialist"
            : "New specialist unavailable while offline",
          disabled: !directory.canCreate,
          icon: "plus",
          label: "New specialist",
          onPress: create,
        },
      }),
    );
  }, [create, directory.canCreate, navigation]);

  const open = useCallback(
    (workspaceId: string) => navigation.navigate("Specialist", { deploymentId, workspaceId }),
    [deploymentId, navigation],
  );

  const loadMore = (): void => {
    if (!directory.hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void props.hostClient
      .loadEarlierWorkspaces()
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "More specialists could not be loaded.")),
      )
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  };

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<WorkspaceSummary>) => (
      <SpecialistRow onPress={open} workspace={item} />
    ),
    [open],
  );

  return (
    <Screen edgeToEdge>
      <FlatList
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        data={directory.specialists}
        keyExtractor={(workspace) => workspace.id}
        ListEmptyComponent={
          !directory.loaded && loadError === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={color.muted} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Symbol name="person.2" size={30} tint={color.mutedDim} />
              <AppText role="title">No specialists yet</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                A specialist keeps its own files, instructions and access for work you come back to.
                You don’t need one to ask in Chat.
              </AppText>
              {directory.canCreate ? (
                <SecondaryButton compact label="New specialist" onPress={create} />
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
              detail={failure ?? loadError ?? ""}
              title="Something did not work"
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

interface SpecialistRowProps {
  readonly onPress: (workspaceId: string) => void;
  readonly workspace: WorkspaceSummary;
}

const SpecialistRow = memo(function SpecialistRow(props: SpecialistRowProps): ReactNode {
  const { workspace } = props;
  const status = specialistStatus(workspace);
  const detail = workspace.description.trim();
  return (
    <Pressable
      accessibilityHint="Opens this specialist"
      accessibilityLabel={[workspace.name, detail, status].filter(Boolean).join(". ")}
      accessibilityRole="button"
      onPress={() => props.onPress(workspace.id)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <WorkspaceMark icon={workspace.icon} name={workspace.name} color={workspace.color} />
      <View style={styles.rowText}>
        <AppText numberOfLines={1} role="title">
          {workspace.name}
        </AppText>
        {detail === "" ? null : (
          <AppText numberOfLines={2} role="secondary" tone="muted">
            {detail}
          </AppText>
        )}
        {status === null ? null : (
          <AppText role="caption" style={styles.status} tone="muted">
            {status}
          </AppText>
        )}
      </View>
      <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
    </Pressable>
  );
}, sameSpecialistRowProps);

function sameSpecialistRowProps(left: SpecialistRowProps, right: SpecialistRowProps): boolean {
  const a = left.workspace;
  const b = right.workspace;
  return (
    left.onPress === right.onPress &&
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.icon === b.icon &&
    a.color === b.color &&
    a.status === b.status &&
    a.storageIssue === b.storageIssue
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
