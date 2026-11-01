import { CHAT_THREAD_TITLE, type BrowserPageContentPart } from "@opensteer/core";
import { mainWorkspace, type HostClient, type HostSnapshot } from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { homeReadFailedLabel } from "../client/saved-view-presentation.js";
import type { ThreadDraftQuote } from "../client/thread-drafts.js";
import { useSidebarMenu } from "../navigation-header.js";
import { color, space } from "../theme.js";
import { SavedChat } from "../thread/saved-chat.js";
import { ThreadPane, type ThreadHeaderState } from "../thread/thread-pane.js";
import { useMobileClient, useHostUserId, useSavedSurface } from "../ui/mobile-client-context.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { HomeIntro, homeIntroDraftKey } from "./home-intro.js";
import { useScopedThreadHeader, useThreadHeader } from "./thread-header.js";

export type HomeScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly messageId?: string | undefined;
  /** A page Ask handed over, for Chat's next message to include. */
  readonly page?: BrowserPageContentPart | undefined;
  readonly quote?: ThreadDraftQuote | undefined;
  readonly requestId?: string | undefined;
}>;

/**
 * Chat: the Deployment's one Home conversation, and the root of its stack.
 *
 * It renders Home in place — the conversation when there is one, the first
 * message before there is — and stays mounted under everything pushed over it,
 * so returning to Chat is returning to the same transcript, scroll position and
 * draft. It never navigates on its own: a link to a task keeps the foreground
 * it asked for, and a link about Chat arrives here with its exact update.
 */
export function HomeScreen(props: HomeScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  const mobile = useMobileClient();
  const saved = useSavedSurface(deploymentId, "home");
  const userId = useHostUserId(hostClient);
  const readIntroHeld = useCallback(
    () => userId !== null && homeIntroHeld(mobile.drafts, deploymentId, userId),
    [mobile.drafts, deploymentId, userId],
  );
  const introHeld = useSyncExternalStore(mobile.drafts.subscribe, readIntroHeld, readIntroHeld);
  const introOwner = useRef<HostClient | null>(null);
  if (hostClient && introHeld) introOwner.current = hostClient;
  const showSaved =
    saved.source === "saved" && (hostClient === null || introOwner.current !== hostClient);
  // The Thread the pane is showing: none while the first message is written.
  const [shownThreadId, setShownThreadId] = useState<string | null>(null);
  useSidebarMenu(hostClient);

  const threadId = hostClient === null ? null : shownThreadId;
  const { header, onHeader } = useScopedThreadHeader(hostClient, threadId);
  useThreadHeader({
    deploymentId,
    fallbackTitle: CHAT_THREAD_TITLE,
    ...(showSaved && saved.source === "saved"
      ? {
          savedSubtitle: {
            label: saved.label,
            capturedAt: saved.capturedAt,
            ...(saved.label === "Unavailable · Saved view"
              ? {
                  onRetry: () => {
                    void mobile.retrySelection();
                  },
                }
              : saved.label === homeReadFailedLabel && hostClient !== null
                ? {
                    // The live pane is not mounted, so Retry reads Home's history again
                    // the way opening it would, keeping the saved text on screen.
                    onRetry: () => {
                      const homeThreadId = hostClient.getSnapshot().homeThreadId;
                      if (homeThreadId) hostClient.activateThread(homeThreadId);
                    },
                  }
                : {}),
          },
        }
      : {}),
    header,
    hostClient,
    threadId,
  });

  if (showSaved && saved.source === "saved")
    return (
      <Screen edgeToEdge>
        <SavedChat
          content={saved.content}
          capturedAt={saved.capturedAt}
          paddingTop={headerHeight}
        />
      </Screen>
    );
  if (hostClient === null) {
    return <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />;
  }
  return (
    <Screen edgeToEdge>
      <HomeChat
        hostClient={hostClient}
        key={deploymentId}
        onHeader={onHeader}
        onShowing={setShownThreadId}
        params={props.route.params}
      />
    </Screen>
  );
}

/** What deciding between Chat and its first message reads, and nothing else. */
interface HomeResolution {
  readonly homeThreadId: string | null;
  readonly mainWorkspaceId: string | null;
  /** An empty list is a Main still being written on a first run, not one that is missing. */
  readonly preparing: boolean;
  readonly userId: string | null;
}

function homeResolution(snapshot: HostSnapshot): HomeResolution {
  return {
    homeThreadId: snapshot.homeThreadId,
    // Home belongs in Main's files and no other Workspace — not the specialist
    // last looked at — stands in.
    mainWorkspaceId: mainWorkspace(snapshot)?.id ?? null,
    preparing: snapshot.workspaces.length === 0,
    userId: snapshot.user?.id ?? null,
  };
}

function sameHomeSnapshot(left: HostSnapshot, right: HostSnapshot): boolean {
  if (left === right) return true;
  const a = homeResolution(left);
  const b = homeResolution(right);
  return (
    a.homeThreadId === b.homeThreadId &&
    a.mainWorkspaceId === b.mainWorkspaceId &&
    a.preparing === b.preparing &&
    a.userId === b.userId
  );
}

function HomeChat(props: {
  readonly hostClient: HostClient;
  readonly onHeader: (header: ThreadHeaderState) => void;
  readonly onShowing: (threadId: string | null) => void;
  readonly params: HomeScreenProps["route"]["params"];
}): ReactNode {
  const headerHeight = useHeaderHeight();
  const column = useReadingColumn();
  // Streaming never re-renders this: only the four facts above do.
  const { loadError, reload, snapshot } = useHostSnapshot(props.hostClient, sameHomeSnapshot);
  const home = homeResolution(snapshot);
  const { deploymentId } = props.params;

  if (home.userId === null || home.preparing) {
    return (
      <View style={[styles.centred, column, { paddingTop: headerHeight }]}>
        {loadError === null ? (
          <>
            <ActivityIndicator color={color.muted} />
            <AppText role="secondary" tone="muted">
              Opening Chat…
            </AppText>
          </>
        ) : (
          <Notice
            action={{ label: "Try again", onPress: () => void reload().catch(() => undefined) }}
            detail={loadError}
            title="Chat could not be opened"
          />
        )}
      </View>
    );
  }
  if (home.homeThreadId === null && home.mainWorkspaceId === null) {
    return (
      <View style={[styles.centred, column, { paddingTop: headerHeight }]}>
        <Notice
          action={{ label: "Try again", onPress: () => void reload().catch(() => undefined) }}
          detail="Chat lives in your Main Workspace, and this deployment has not reported it yet."
          title="Your Main Workspace isn’t available"
          tone="neutral"
        />
      </View>
    );
  }
  return (
    <HomeConversation
      deploymentId={deploymentId}
      homeThreadId={home.homeThreadId}
      hostClient={props.hostClient}
      key={`${deploymentId}:${home.userId}`}
      mainWorkspaceId={home.mainWorkspaceId}
      onHeader={props.onHeader}
      onShowing={props.onShowing}
      params={props.params}
      userId={home.userId}
    />
  );
}

/**
 * One signed-in person's Chat. Keyed by them, so a different person on the
 * same Deployment starts from their own draft rather than the last one's.
 */
function HomeConversation(props: {
  readonly deploymentId: string;
  readonly homeThreadId: string | null;
  readonly hostClient: HostClient;
  readonly mainWorkspaceId: string | null;
  readonly onHeader: (header: ThreadHeaderState) => void;
  readonly onShowing: (threadId: string | null) => void;
  readonly params: HomeScreenProps["route"]["params"];
  readonly userId: string;
}): ReactNode {
  const navigation = useNavigation();
  const drafts = useMobileClient().drafts;
  const { deploymentId, homeThreadId, hostClient, mainWorkspaceId, onShowing, userId } = props;
  const { messageId, page, quote, requestId } = props.params;
  // A first message written before Home existed is still owed a decision: the
  // Home that exists may be one another device started on a different AI. The
  // intro is where it is named and sent — a message handed over, or words, a
  // quote or files saved but not yet sent — so it stays until it says it is done.
  const [intro, setIntro] = useState(() => {
    if (homeThreadId === null) return true;
    return homeIntroHeld(drafts, deploymentId, userId);
  });
  // The Home the intro just made, for the moment before the snapshot names it.
  const [created, setCreated] = useState<string | null>(null);
  const threadId = homeThreadId ?? created;
  const showIntro = mainWorkspaceId !== null && (intro || threadId === null);
  const shown = showIntro ? null : threadId;

  useEffect(() => onShowing(shown), [onShowing, shown]);

  const onHomeReady = useCallback((id: string) => {
    setCreated(id);
    setIntro(false);
  }, []);
  const onQuoteTaken = useCallback(() => navigation.setParams({ quote: undefined }), [navigation]);
  const onAnchorReleased = useCallback(
    () => navigation.setParams({ messageId: undefined }),
    [navigation],
  );
  // A page Ask handed over rides with the next message this person sends here,
  // and is let go once one is on its way; leaving sends nothing. A message
  // already owed when it arrived is not that message.
  useEffect(() => {
    if (page === undefined || threadId === null) return;
    const owed = () => drafts.readPending(deploymentId, userId, threadId)?.idempotencyKey ?? null;
    const before = owed();
    return drafts.subscribe(() => {
      const now = owed();
      if (now !== null && now !== before) navigation.setParams({ page: undefined });
    });
  }, [deploymentId, drafts, navigation, page, threadId, userId]);
  const openThread = useCallback(
    (id: string) =>
      navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id })),
    [deploymentId, navigation],
  );

  if (showIntro) {
    return (
      <HomeIntro
        deploymentId={deploymentId}
        hostClient={hostClient}
        onHomeReady={onHomeReady}
        onQuoteTaken={onQuoteTaken}
        quote={quote ?? null}
        userId={userId}
        workspaceId={mainWorkspaceId}
      />
    );
  }
  if (threadId === null) return null;
  return (
    <ThreadPane
      askedPage={page ?? null}
      deploymentId={deploymentId}
      hostClient={hostClient}
      key={`${deploymentId}:${threadId}`}
      messageId={messageId ?? null}
      onAnchorReleased={onAnchorReleased}
      onHeader={props.onHeader}
      onOpenThread={openThread}
      onQuoteTaken={onQuoteTaken}
      quote={quote ?? null}
      requestId={requestId ?? null}
      threadId={threadId}
    />
  );
}

function homeIntroHeld(
  drafts: import("../client/thread-drafts.js").ThreadDraftStore,
  deploymentId: string,
  userId: string,
): boolean {
  if (drafts.readPending(deploymentId, userId, homeIntroDraftKey) !== null) return true;
  const draft = drafts.readDraft(deploymentId, userId, homeIntroDraftKey);
  return (
    draft !== null &&
    (draft.text.trim() !== "" || draft.quote !== undefined || (draft.attachments?.length ?? 0) > 0)
  );
}

const styles = StyleSheet.create({
  centred: {
    alignItems: "center",
    flex: 1,
    gap: space[12],
    justifyContent: "center",
    padding: space[16],
  },
});
