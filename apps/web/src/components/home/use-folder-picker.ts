import { TaskFolderSchema, type TaskFolder } from "@opensteer/core";
import { newTaskDefaults, taskFolderKey, unwrapRpcResult } from "@opensteer/client/host";
import { useMemo, useState } from "react";
import { useShell } from "../app-shell.js";
import { folderView } from "./folder-groups.js";
import type { FolderPickerProps } from "./folder-picker.js";
import type { FolderBrowseView, FolderView } from "./home-models.js";

/**
 * Everything a folder chip needs to offer a choice: Agent home and recent
 * folders, then any folder on a computer that runs tasks, read from its
 * Runner. Null until the Host has said where Agent home is.
 */
export function useFolderPicker(
  current: TaskFolder | null,
  onChange: (folder: TaskFolder) => void,
  extraRecent: readonly TaskFolder[] = [],
): FolderPickerProps | null {
  const { hostClient, snapshot } = useShell();
  const defaults = newTaskDefaults(snapshot);
  const agentHome = defaults.folder;
  const computerName = (computerId: string) =>
    snapshot.machines.find((machine) => machine.id === computerId)?.name ?? "This computer";
  // Only the hosting computer runs tasks in this build; the Host says which that is.
  const computers = defaults.environments.flatMap((environment) =>
    environment.runnerId === null
      ? []
      : [
          {
            id: environment.runnerId,
            name: computerName(environment.runnerId),
            kind: "laptop" as const,
            hosting: true,
            online: environment.connected,
          },
        ],
  );
  const known = useMemo(() => {
    const folders = new Map<string, TaskFolder>();
    for (const folder of [
      ...(agentHome ? [agentHome] : []),
      ...extraRecent,
      ...snapshot.threads.filter(({ purpose }) => purpose === "task").map(({ folder }) => folder),
    ])
      if (!folders.has(taskFolderKey(folder))) folders.set(taskFolderKey(folder), folder);
    return folders;
  }, [agentHome, extraRecent, snapshot.threads]);
  const recent = useMemo<FolderView[]>(
    () =>
      [...known.values()].slice(0, 6).map((folder) => folderView(folder, agentHome, computerName)),
    [agentHome, known, snapshot.machines],
  );
  const [browsing, setBrowsing] = useState<FolderBrowseView | null>(null);
  const browse = (computerId: string, path: string | null) => {
    const computer = computers.find((candidate) => candidate.id === computerId);
    const at = path ?? agentHome?.path ?? "/";
    if (!computer) return;
    const crumbs = at
      .split("/")
      .filter(Boolean)
      .map((label, index, parts) => ({ label, path: `/${parts.slice(0, index + 1).join("/")}` }));
    setBrowsing({ computer, path: at, crumbs, entries: null });
    void hostClient.rpc["folder.files.list"]({
      folder: TaskFolderSchema.parse({ computerId, path: at }),
      parentKey: "",
    })
      .then(unwrapRpcResult)
      .then((page) =>
        setBrowsing((held) =>
          held?.path === at
            ? {
                ...held,
                entries: page.entries
                  .filter((entry) => entry.kind === "directory" && !entry.hidden)
                  .map((entry) => ({
                    name: entry.name,
                    path: `${at.replace(/\/$/u, "")}/${entry.name}`,
                  })),
              }
            : held,
        ),
      )
      .catch((error: unknown) =>
        setBrowsing((held) =>
          held?.path === at
            ? {
                ...held,
                entries: [],
                error: error instanceof Error ? error.message : "Can’t read this folder.",
              }
            : held,
        ),
      );
  };
  const chosen = current ?? agentHome;
  if (!chosen) return null;
  return {
    browsing,
    computers,
    current: folderView(chosen, agentHome, computerName),
    onBrowse: browse,
    onChoose: (view) => {
      const next = known.get(view.id);
      if (next) onChange(next);
    },
    onUse: (computerId, path) => onChange(TaskFolderSchema.parse({ computerId, path })),
    recent,
  };
}
