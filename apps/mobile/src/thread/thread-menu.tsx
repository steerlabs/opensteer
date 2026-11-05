import { heldThread, taskCanBeDone, type HostClient } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  Platform,
  StyleSheet,
  type HostInstance,
} from "react-native";
import { color, space } from "../theme.js";
import { setTaskDone } from "../threads/task-row.js";
import { TaskIconPicker } from "../ui/mark-picker.js";
import { Symbol } from "../ui/symbol.js";
import { NativeMenu, type NativeMenuOption } from "./composer-menu.js";
import { conversationActions } from "./conversation-actions.js";
import { RenameTaskDialog } from "./rename-task-dialog.js";
import { useAssignmentStop, useLifecycleNews } from "./task-line.js";
import type { TaskHeading } from "./task-status.js";

interface ThreadMenuProps {
  readonly children: ReactNode;
  readonly connectionLabel?: string | null;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  /** Chat's name says nothing the menu needs to repeat. */
  readonly isHome?: boolean;
  /** The native menu sizes its trigger to its content; a width keeps long titles inside the bar. */
  readonly maxWidth: number;
  readonly onFind: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly projectName?: string | null;
  readonly task: TaskHeading | null;
  readonly threadId: string;
  readonly title: string;
}

/**
 * The menu behind a conversation's title. Every conversation has one, so a
 * title always answers a tap: what can be done with the conversation, then
 * with the task it is, then stopping it, each group apart from the next.
 */
export function ThreadMenu(props: ThreadMenuProps): ReactNode {
  const { task, threadId } = props;
  useLifecycleNews(task?.announcement ?? "");
  return task === null ? (
    <Menu key={threadId} {...props} />
  ) : (
    <AssignedMenu key={threadId} {...props} task={task} />
  );
}

function AssignedMenu(props: ThreadMenuProps & { readonly task: TaskHeading }): ReactNode {
  const stop = useAssignmentStop(props.hostClient, {
    assignmentId: props.task.assignmentId,
    requester: props.task.requester,
    title: props.title,
  });
  return <Menu {...props} stop={stop} />;
}

function Menu(
  props: ThreadMenuProps & { readonly stop?: ReturnType<typeof useAssignmentStop> },
): ReactNode {
  const { hostClient, task, title, threadId } = props;
  const [renaming, setRenaming] = useState(false);
  const [changingIcon, setChangingIcon] = useState(false);
  const trigger = useRef<HostInstance>(null);
  const restoreFocus = () => {
    const handle = findNodeHandle(trigger.current);
    if (typeof handle === "number") AccessibilityInfo.setAccessibilityFocus(handle);
  };
  const ownName = useHostSelector(
    hostClient,
    (snapshot) =>
      snapshot.homeThreadId !== threadId &&
      snapshot.voiceThreadId !== threadId &&
      !snapshot.workspaces.some((workspace) => workspace.homeThreadId === threadId),
  );
  const canRename =
    useHostSelector(hostClient, (snapshot) => snapshot.threadRenameAvailable) && ownName;
  const canChangeIcon =
    useHostSelector(hostClient, (snapshot) => snapshot.taskMarksAvailable) && ownName;
  const doneThread = useHostSelector(hostClient, (snapshot) => {
    const thread = heldThread(snapshot, threadId);
    return thread !== null && taskCanBeDone(snapshot, thread) ? thread : null;
  });
  const requesterThreadId = task?.requesterThreadId ?? null;
  const taskActions: readonly NativeMenuOption[] = [
    ...(doneThread === null
      ? []
      : [
          {
            icon:
              doneThread.doneAt === null
                ? ("checkmark" as const)
                : ("arrow.uturn.backward" as const),
            id: "done",
            label: doneThread.doneAt === null ? "Mark Done" : "Reopen",
            onPress: () => setTaskDone(hostClient, doneThread.id, doneThread.doneAt === null),
          },
        ]),
    ...(canRename
      ? [
          {
            icon: "pencil" as const,
            id: "rename",
            label: "Rename…",
            onPress: () => setRenaming(true),
          },
        ]
      : []),
    ...(canChangeIcon
      ? [
          {
            icon: "square.grid.2x2" as const,
            id: "icon",
            label: "Change icon…",
            onPress: () => setChangingIcon(true),
          },
        ]
      : []),
    ...(requesterThreadId === null
      ? []
      : [
          {
            icon: "bubble.left" as const,
            id: "open",
            label: `Open ${task?.requester}`,
            onPress: () => props.onOpenThread(requesterThreadId),
          },
        ]),
  ];
  const stopAction: readonly NativeMenuOption[] = task?.open
    ? [
        {
          destructive: true,
          disabled: task.stopBlocked !== null,
          icon: "stop.circle",
          id: "stop",
          label: "Stop Task…",
          onPress: () => props.stop?.ask(),
        },
      ]
    : [];
  const state = props.connectionLabel ?? task?.word ?? null;
  const label = [title, props.projectName, state].filter(Boolean).join(", ");
  return (
    <>
      {props.stop?.sheet}
      {renaming && canRename ? (
        <RenameTaskDialog
          key={threadId}
          hostClient={hostClient}
          threadId={threadId}
          title={title}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {changingIcon && canChangeIcon ? (
        <TaskIconPicker
          hostClient={hostClient}
          threadId={threadId}
          onClose={() => setChangingIcon(false)}
          onDismiss={restoreFocus}
        />
      ) : null}
      <NativeMenu
        accessibilityHint="Shows what you can do with this conversation"
        accessibilityLabel={`${label}. Actions`}
        options={[
          taskActions,
          conversationActions({
            deploymentId: props.deploymentId,
            onFind: props.onFind,
            threadId,
          }),
          stopAction,
        ]}
        {...(props.isHome === true ? {} : { title: menuHeading(props) })}
        triggerRef={trigger}
        triggerStyle={[styles.trigger, { maxWidth: props.maxWidth }]}
      >
        {props.children}
        <Symbol name="chevron.down" size={11} tint={color.muted} weight="bold" />
      </NativeMenu>
    </>
  );
}

/** Where the bar shortens things: the whole name or who asked, the project, and any blocker. */
function menuHeading(props: ThreadMenuProps): string {
  const { projectName, task, title } = props;
  return [
    task === null ? title : `From ${task.requester} · ${task.word}`,
    projectName,
    task?.detail,
  ]
    .filter(Boolean)
    .join("\n");
}

const styles = StyleSheet.create({
  trigger: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[4],
    flexShrink: 1,
    minHeight: Platform.OS === "android" ? 48 : 44,
  },
});
