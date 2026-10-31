import { useHostSelector } from "@opensteer/client/react";
import {
  sameTaskFamilyGlance,
  taskFamilyGlance,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { browserHeaderActions } from "../navigation-header.js";
import { color, headerFontScaleLimit, space } from "../theme.js";
import { sameThreadHeader, type ThreadHeaderState } from "../thread/thread-pane.js";
import { FamilyButton, TaskFamilySheet, familyCount, familyLabel } from "../thread/task-family.js";
import { TaskMenu, useTaskMenuChoices } from "../thread/task-status.js";
import { ThreadName, ThreadSubtitle } from "../thread/thread-subtitle.js";
import { AppText } from "../ui/primitives.js";
import { useLiquidGlass } from "../ui/glass.js";
import { useHostUserId } from "../ui/mobile-client-context.js";

interface ScopedHeader {
  readonly header: ThreadHeaderState;
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly userId: string | null;
}

/**
 * The header a pane reported, for exactly the Host, reader and Thread it was
 * reported under.
 *
 * A header is the reader's own words — a task's title, a workspace name — so
 * one reported under another attachment, another signed-in person or another
 * Thread is never shown: it is dropped in the same render that changes any of
 * them, before the bar can paint it, and the pane reports afresh. Only a
 * change to the values reaches the bar: an unchanged set is dropped here
 * rather than rebuilding a header component while the transcript streams.
 */
export function useScopedThreadHeader(
  hostClient: HostClient | null,
  threadId: string | null,
): {
  readonly header: ThreadHeaderState | null;
  readonly onHeader: (header: ThreadHeaderState) => void;
} {
  const userId = useHostUserId(hostClient);
  const [scoped, setScoped] = useState<ScopedHeader | null>(null);
  const onHeader = useCallback(
    (next: ThreadHeaderState) => {
      if (hostClient === null || threadId === null) return;
      setScoped((current) =>
        current !== null &&
        current.hostClient === hostClient &&
        current.threadId === threadId &&
        current.userId === userId &&
        sameThreadHeader(current.header, next)
          ? current
          : { header: next, hostClient, threadId, userId },
      );
    },
    [hostClient, threadId, userId],
  );
  const header =
    scoped !== null &&
    scoped.hostClient === hostClient &&
    scoped.threadId === threadId &&
    scoped.userId === userId
      ? scoped.header
      : null;
  return { header, onHeader };
}

/**
 * The bar over a conversation — Chat or a task.
 *
 * The bar is transparent and the transcript runs under it. That is why the
 * header is configured by the screen rather than in the route table: it needs
 * the thread's own name and state, and it needs to know whether this build
 * draws Liquid Glass — on iOS 26 the scroll edge effect is the system's own
 * answer, and below it a blur is.
 *
 * Tabs stays contextual: it appears only while the conversation, including
 * work it handed out, has a tab or a Mac app open, and it always opens the
 * conversation's collection of them, even of one — the composer's preview is
 * the way straight to a tab. The title is the conversation's name and,
 * for a task someone handed out, where it stands and its menu: Run details
 * opens from the reply under way and from each reply's menu, where the reader
 * is already looking.
 */
export function useThreadHeader(props: {
  readonly deploymentId: string;
  /** What the bar says while no current header has been reported. */
  readonly fallbackTitle: string;
  readonly savedSubtitle?: {
    readonly label: string;
    readonly capturedAt: string;
    readonly onRetry?: () => void;
  };
  /** The pane's header values, scoped by `useScopedThreadHeader`. */
  readonly header: ThreadHeaderState | null;
  /** The attached Host, or null while the screen is waiting for one. */
  readonly hostClient: HostClient | null;
  readonly threadId: string | null;
}): void {
  const navigation = useNavigation();
  const glass = useLiquidGlass();
  const { deploymentId, fallbackTitle, header, hostClient, threadId, savedSubtitle } = props;
  useLayoutEffect(() => {
    const attached = hostClient !== null && threadId !== null;
    navigation.setOptions({
      ...(attached && header !== null && !savedSubtitle
        ? {}
        : browserHeaderActions(false, false, () => {})),
      // The route table paints every header with the product's ground. A
      // transparent header has to be told to keep none, or nothing scrolls
      // under it and the blur has nothing to blur.
      headerStyle: { backgroundColor: "transparent" },
      headerTransparent: true,
      ...(glass
        ? {
            // iOS 26's own answer, and it must not be combined with a blur:
            // the two effects stack and the bar doubles its own haze. The
            // bottom edge is the composer's, so the system draws none there.
            scrollEdgeEffects: {
              bottom: "hidden" as const,
              left: "automatic" as const,
              right: "automatic" as const,
              top: "soft" as const,
            },
          }
        : { headerBlurEffect: "systemChromeMaterialDark" as const }),
      // Both keys are always written: the navigator merges options, so a title
      // left out would keep whatever an earlier header put there.
      ...(savedSubtitle
        ? {
            headerTitle: () => (
              <View
                accessibilityLabel={`${fallbackTitle}. Saved view, last updated ${savedSubtitle.capturedAt}.`}
              >
                <AppText role="title">{fallbackTitle}</AppText>
                <ThreadSubtitle
                  workspaceName={null}
                  workspaceColor={null}
                  workspaceIcon={null}
                  connectionLabel={savedSubtitle.label}
                  onRetry={savedSubtitle.onRetry}
                  task={null}
                />
              </View>
            ),
            title: fallbackTitle,
          }
        : header === null || hostClient === null
          ? { headerTitle: fallbackTitle, title: fallbackTitle }
          : {
              headerTitle: () => (
                <ThreadTitle
                  {...header}
                  deploymentId={deploymentId}
                  threadId={threadId}
                  hostClient={hostClient}
                  // Chat is the root under every stack, so it is returned to,
                  // never opened a second time over this task.
                  onOpenThread={(id) =>
                    navigation.dispatch(
                      id === hostClient.getSnapshot().homeThreadId
                        ? StackActions.popTo("Home", { deploymentId })
                        : StackActions.push("Thread", { deploymentId, threadId: id }),
                    )
                  }
                  onRetry={() =>
                    void hostClient.refresh({ retryConnection: true }).catch(() => undefined)
                  }
                />
              ),
              // The route keeps a plain name as well: it is what a back control
              // on the screen above this one has to say.
              title: header.title,
            }),
    });
  }, [deploymentId, fallbackTitle, glass, header, hostClient, navigation, threadId, savedSubtitle]);
}

/**
 * The task subject and title, with a small specialist tile and state below.
 * The two lines share the native menu's touch target; Retry remains its own control.
 */
function ThreadTitle(
  props: ThreadHeaderState & {
    readonly deploymentId: string;
    readonly hostClient: HostClient;
    readonly threadId: string | null;
    readonly onOpenThread: (threadId: string) => void;
    readonly onRetry: () => void;
  },
): ReactNode {
  const navigation = useNavigation();
  const userId = useHostUserId(props.hostClient);
  const [familyOwner, setFamilyOwner] = useState<{
    host: HostClient;
    thread: string | null;
    user: string | null;
  } | null>(null);
  const familyOpen =
    familyOwner?.host === props.hostClient &&
    familyOwner.thread === props.threadId &&
    familyOwner.user === userId;
  const selectGlance = useCallback(
    (snapshot: HostSnapshot) =>
      props.threadId === null ? null : taskFamilyGlance(snapshot, props.threadId),
    [props.threadId],
  );
  const glance = useHostSelector(props.hostClient, selectGlance, sameTaskFamilyGlance);
  const { deploymentId, threadId, surfacesActing, surfaceCount } = props;
  useLayoutEffect(() => {
    const open = () => setFamilyOwner({ host: props.hostClient, thread: threadId, user: userId });
    navigation.setOptions(
      browserHeaderActions(
        surfacesActing,
        surfaceCount > 0,
        () =>
          navigation.dispatch(StackActions.push("WorkspaceBrowser", { deploymentId, threadId })),
        glance === null
          ? undefined
          : {
              action: {
                // UIKit displays the image instead of the title. Badges carry
                // the counts on iOS 26; older bars use a compact text glyph.
                ...(Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) < 26
                  ? { label: `⑂ ${familyCount(glance)}` }
                  : {
                      icon: "arrow.triangle.branch" as const,
                      label: familyCount(glance),
                      badge: familyCount(glance),
                    }),
                accessibilityLabel: familyLabel(glance),
                tintColor: glance.needsYou
                  ? color.amber
                  : glance.running > 0
                    ? color.text
                    : color.muted,
                onPress: open,
              },
              content: <FamilyButton glance={glance} onPress={open} />,
            },
      ),
    );
  }, [
    deploymentId,
    glance,
    navigation,
    surfaceCount,
    surfacesActing,
    threadId,
    props.hostClient,
    userId,
  ]);
  const menu = useTaskMenuChoices(props.hostClient, props.threadId, props.task);
  return (
    <View style={styles.title}>
      {familyOpen && threadId !== null ? (
        <TaskFamilySheet
          key={threadId}
          hostClient={props.hostClient}
          threadId={threadId}
          onClose={() => setFamilyOwner(null)}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
      <TaskMenu
        hostClient={props.hostClient}
        maxWidth={titleWidth}
        onOpenThread={props.onOpenThread}
        task={props.task}
        specialistName={props.workspaceName}
        connectionLabel={props.connectionLabel}
        threadId={props.threadId}
        title={props.title}
      >
        <View style={styles.words}>
          <ThreadName
            maxFontSizeMultiplier={headerFontScaleLimit}
            numberOfLines={1}
            title={props.title}
            icon={props.icon}
            color={props.color}
            isHome={props.isHome}
          />
          <ThreadSubtitle
            workspaceName={props.workspaceName}
            workspaceColor={props.workspaceColor}
            workspaceIcon={props.workspaceIcon}
            connectionLabel={props.connectionLabel}
            // A title with a menu says "Completed" in the menu and in its
            // accessible name, so the bar keeps one line for the title. A
            // title without one keeps the word: the drawn transcript may be a
            // window from before the ending. Every other state stays here.
            task={menu.any && props.task?.tone === "completed" ? null : props.task}
          />
        </View>
      </TaskMenu>
      {props.canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          onPress={props.onRetry}
          style={styles.retry}
        >
          <AppText role="caption" tone="soft">
            Retry
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

// Wide enough for a real thread title, narrow enough never to reach the bar's
// own controls: the native title slot is centred between them.
const titleWidth = 260;

const styles = StyleSheet.create({
  title: { alignItems: "center", flexDirection: "row", maxWidth: titleWidth, gap: space[4] },
  words: { alignItems: "center", flexShrink: 1 },
  retry: {
    minHeight: Platform.OS === "android" ? 48 : 44,
    minWidth: 48,
    alignItems: "center",
    justifyContent: "center",
  },
});
