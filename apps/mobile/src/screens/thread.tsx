import type { HostClient } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useEffect, type ReactNode } from "react";
import { ThreadPane, type ThreadHeaderState } from "../thread/thread-pane.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useScopedThreadHeader, useThreadHeader } from "./thread-header.js";

export type ThreadScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  /** The exact update to open at, when a notification or link named one. */
  readonly messageId?: string | undefined;
  readonly requestId?: string;
  readonly threadId: string;
}>;

/**
 * One task on its own screen. It is also the screen a notification tap and a
 * deep link arrive at, so it has to stand up before the deployment it names
 * is attached — which is why it says what it is waiting for rather than
 * spinning.
 */
export function ThreadScreen(props: ThreadScreenProps): ReactNode {
  const { deploymentId, threadId } = props.route.params;
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  const { header, onHeader } = useScopedThreadHeader(hostClient, threadId);
  useThreadHeader({ deploymentId, fallbackTitle: "", header, hostClient, threadId });

  if (hostClient === null) {
    return <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />;
  }
  return (
    <AttachedThread
      hostClient={hostClient}
      messageId={props.route.params.messageId}
      onHeader={onHeader}
      params={props.route.params}
    />
  );
}

const selectHomeThreadId = (snapshot: { readonly homeThreadId: string | null }) =>
  snapshot.homeThreadId;

function AttachedThread(props: {
  readonly hostClient: HostClient;
  readonly messageId: string | undefined;
  readonly onHeader: (header: ThreadHeaderState) => void;
  readonly params: ThreadScreenProps["route"]["params"];
}): ReactNode {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const homeThreadId = useHostSelector(props.hostClient, selectHomeThreadId);
  const { deploymentId, requestId, threadId } = props.params;
  const isHome = homeThreadId === threadId;

  // Chat has one screen, the root under everything. A link or notification
  // about Chat — a report into it, a Request asked there — names its Thread,
  // so it arrives here and goes on to Chat with its exact update, rather
  // than opening a second Chat whose draft would drift from the first.
  useEffect(() => {
    if (!isHome || !focused) return;
    navigation.dispatch(
      StackActions.popTo("Home", {
        deploymentId,
        ...(props.messageId === undefined ? {} : { messageId: props.messageId }),
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
  }, [deploymentId, focused, isHome, navigation, props.messageId, requestId]);

  if (isHome) return <Screen>{null}</Screen>;
  return (
    <Screen edgeToEdge>
      <ThreadPane
        deploymentId={deploymentId}
        hostClient={props.hostClient}
        key={`${deploymentId}:${threadId}`}
        onHeader={props.onHeader}
        messageId={props.messageId ?? null}
        onAnchorReleased={() => navigation.setParams({ messageId: undefined })}
        // Pushed: navigating to Thread from a Thread would replace this one,
        // and Back would skip past it.
        onOpenThread={(id) =>
          navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }))
        }
        requestId={requestId ?? null}
        threadId={threadId}
      />
    </Screen>
  );
}
