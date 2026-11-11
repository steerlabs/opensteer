import { PersonalTeamLinks, taskList, unwrapRpcResult } from "@opensteer/client/host";
import type { TaskFolder } from "@opensteer/core";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { taskFolderKey } from "@opensteer/client/host";
import { useAttachedHost } from "../screens/deployment-gate.js";
import { folderLabel } from "../screens/home.js";
import { Screen } from "../ui/screen.js";
import { FolderBrowserBody, FolderSheetBody } from "./folder-sheet.js";
import type { FolderChoiceView, FolderEntryView } from "./home-models.js";

/**
 * Where a new task works, or — opened from a channel's Details — where runs
 * started from that channel work. Recent folders first, then the computer
 * whose folders can be browsed: in this build, the one this Opensteer runs on.
 */
export function FolderPickerScreen(
  props: StaticScreenProps<{
    readonly deploymentId: string;
    readonly teamId?: string | undefined;
    readonly channelId?: string | undefined;
  }>,
): ReactNode {
  const { deploymentId, teamId, channelId } = props.route.params;
  const navigation = useNavigation();
  const hostClient = useAttachedHost(deploymentId);
  const snapshot = hostClient?.getSnapshot() ?? null;
  const home = snapshot?.personalSettings?.agentHome ?? null;
  const [browsing, setBrowsing] = useState<TaskFolder | null>(null);
  const recent = useMemo(() => {
    if (snapshot === null) return [];
    const list = taskList(snapshot);
    const folders = new Map<string, TaskFolder>();
    if (home !== null) folders.set(taskFolderKey(home), home);
    for (const row of [...list.working, ...list.ready, ...list.done])
      if (folders.size < 8) folders.set(taskFolderKey(row.folder), row.folder);
    return [...folders.values()];
  }, [home, snapshot]);
  const choose = (folder: TaskFolder): void => {
    if (teamId !== undefined && channelId !== undefined && hostClient !== null) {
      void new PersonalTeamLinks(hostClient.rpc).setFolder(teamId, channelId, folder).then(
        () => navigation.goBack(),
        (error: unknown) =>
          Alert.alert("Folder not changed", error instanceof Error ? error.message : undefined),
      );
      return;
    }
    navigation.dispatch(StackActions.popTo("Home", { deploymentId, folder }));
  };
  if (browsing !== null)
    return (
      <Screen>
        <FolderBrowser
          folder={browsing}
          hostClient={hostClient}
          onOpen={(path) => setBrowsing({ ...browsing, path })}
          onUse={() => choose(browsing)}
        />
      </Screen>
    );
  const views: FolderChoiceView[] = recent.map((folder) => ({
    id: taskFolderKey(folder),
    label: folderLabel(folder, home),
    detail: folder.path,
    home: home !== null && taskFolderKey(folder) === taskFolderKey(home),
    current: false,
  }));
  const computer = snapshot?.environments.find((environment) => environment.can.executeTasks);
  return (
    <Screen>
      <FolderSheetBody
        computers={
          home === null
            ? []
            : [
                {
                  id: home.computerId,
                  name: computer?.name ?? "This computer",
                  kind: "laptop",
                  unavailable: computer?.connected === false ? "Offline" : null,
                },
              ]
        }
        onBrowse={() => {
          if (home !== null) setBrowsing(home);
        }}
        onChoose={(id) => {
          const folder = recent.find((candidate) => taskFolderKey(candidate) === id);
          if (folder !== undefined) choose(folder);
        }}
        recent={views}
      />
    </Screen>
  );
}

function FolderBrowser(props: {
  readonly folder: TaskFolder;
  readonly hostClient: ReturnType<typeof useAttachedHost>;
  readonly onOpen: (path: string) => void;
  readonly onUse: () => void;
}): ReactNode {
  const { folder, hostClient } = props;
  const [entries, setEntries] = useState<readonly FolderEntryView[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (hostClient === null) return;
    let current = true;
    setEntries(null);
    void hostClient.rpc["folder.files.list"]({ folder, parentKey: "" })
      .then(unwrapRpcResult)
      .then(
        (page) =>
          current &&
          setEntries(
            page.entries
              .filter((entry) => entry.kind === "directory" && !entry.hidden)
              .map((entry) => ({
                name: entry.name,
                path: `${folder.path.replace(/\/+$/, "")}/${entry.name}`,
              })),
          ),
        (error: unknown) =>
          current && setFailure(error instanceof Error ? error.message : "Folders didn't load."),
      );
    return () => {
      current = false;
    };
  }, [folder, hostClient]);
  return (
    <FolderBrowserBody
      entries={entries}
      failure={failure}
      name={folder.path.split("/").filter(Boolean).at(-1) ?? folder.path}
      onNewFolder={() => undefined}
      onOpen={props.onOpen}
      onUse={props.onUse}
      path={folder.path}
    />
  );
}
