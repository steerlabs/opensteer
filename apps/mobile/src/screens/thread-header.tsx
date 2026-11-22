import { useHostSelector, useRunPageView } from "@opensteer/client/react";
import {
  conversationThreadIds,
  listedRowThreadId,
  runPageOpened,
  type HostClient,
  type TabDestination,
} from "@opensteer/client/host";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { headerFontScaleLimit, space } from "../theme.js";
import {
  AroundButton,
  aroundBarItem,
  aroundHeaderOptions,
  barOverContentOptions,
  type AroundWidths,
} from "../thread/around-button.js";
import {
  aroundGlanceSelector,
  sameAroundGlance,
  type AroundGlance,
} from "../thread/around-model.js";
import { FoldedPage, foldedPageWidth } from "../thread/folded-page.js";
import { useOpenPlace } from "../tabs/viewer-open.js";
import { sameThreadHeader, type ThreadHeaderState } from "../thread/thread-pane.js";
import { TaskStateIndicator } from "../thread/task-status.js";
import type { NativeMenuOption } from "../thread/composer-menu.js";
import { openTopLevel } from "../top-level.js";
import { ThreadMenu } from "../thread/thread-menu.js";
import { useAssignmentStopLine } from "../thread/reviewed-stop.js";
import { ThreadName, ThreadSubtitle } from "../thread/thread-subtitle.js";
import { AppText } from "../ui/primitives.js";
import { barGlassInset, barTitleWidth, barYield, useBarTitleRoom } from "../ui/bar-title.js";
import { GlassSurface, useLiquidGlass } from "../ui/glass.js";
import { useHostUserId } from "../ui/mobile-client-context.js";
import { useVerticalBar } from "../ui/vertical-bar.js";
import { nativeHeaderItem } from "../ui/header-item.js";

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
 * The bar over a task or a voice conversation.
 *
 * The transcript runs under it, which is why the header is configured by the
 * screen rather than in the route table: it needs the thread's own name and
 * state, and what separates it from the words beneath differs by platform.
 *
 * What is around the conversation stays contextual: one control appears only
 * while it has a tab, Mac app or phone open, tasks or schedules of its own, or
 * a conversation it works for, and it opens Around this thread, where each
 * row opens exactly what it names. The title is the conversation's name and
 * where it stands, and it opens the conversation's menu: Run details opens
 * from the reply under way and from each reply's menu, where the reader is
 * already looking.
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
      ...(attached && header !== null && !savedSubtitle ? {} : aroundHeaderOptions(null)),
      ...barOverContentOptions(glass),
      headerTransparent: true,
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
                  connectionLabel={savedSubtitle.label}
                  onRetry={savedSubtitle.onRetry}
                  task={null}
                />
              </View>
            ),
            title: fallbackTitle,
          }
        : header === null || hostClient === null || threadId === null
          ? { headerTitle: fallbackTitle, title: fallbackTitle }
          : {
              headerTitle: () => (
                <ThreadTitle
                  {...header}
                  deploymentId={deploymentId}
                  threadId={threadId}
                  hostClient={hostClient}
                  onOpenThread={(id) =>
                    navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }))
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
 * The glance with its working count kept current: an agent starting or
 * stopping in a tab changes the Host's per-tab activity, not the snapshot.
 */
function useWorkingGlance(
  hostClient: HostClient,
  threadId: string,
  glance: AroundGlance | null,
): AroundGlance | null {
  const keys = glance?.placeKeys ?? noKeys;
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = keys.map((key) => hostClient.subscribePlaceActivity(key, listener));
      return () => {
        for (const release of releases) release();
      };
    },
    [hostClient, keys],
  );
  const read = useCallback(() => {
    const threads = conversationThreadIds(hostClient.getSnapshot(), threadId);
    return keys.filter((key) =>
      hostClient.placeActivity(key).some((record) => threads.has(record.threadId)),
    ).length;
  }, [hostClient, keys, threadId]);
  const working = useSyncExternalStore(subscribe, read, read);
  return useMemo(
    () =>
      glance === null || glance.placesWorking === working
        ? glance
        : { ...glance, placesWorking: working },
    [glance, working],
  );
}
const noKeys: readonly string[] = [];

/** The standalone screen's title: the pill, and Around beside it in the bar. */
function ThreadTitle(
  props: ThreadHeaderState & {
    readonly deploymentId: string;
    readonly hostClient: HostClient;
    readonly threadId: string;
    readonly onOpenThread: (threadId: string) => void;
  },
): ReactNode {
  const navigation = useNavigation();
  const selectAround = useMemo(
    () => aroundGlanceSelector(props.threadId, props.hostClient.placeActivity),
    [props.hostClient, props.threadId],
  );
  const glance = useWorkingGlance(
    props.hostClient,
    props.threadId,
    useHostSelector(props.hostClient, selectAround, sameAroundGlance),
  );
  // A folded page stands beside Around; the title takes what they leave, and
  // when that is short of its name, Around gives up parts until it is not.
  const [page, updatePage] = useRunPageView(props.hostClient, props.threadId);
  const foldedRunId = page.shown === "folded" ? page.runId : null;
  const room = page.room;
  // Beside a vertical bar, Around is a plain item there; only a folded page stays in the row.
  const verticalBar = useVerticalBar();
  const aroundInRow = glance !== null && !verticalBar;
  const hasEnd = aroundInRow || foldedRunId !== null;
  const glass = useLiquidGlass();
  const [around, setAround] = useState<AroundWidths | null>(null);
  const [need, setNeed] = useState<number | null>(null);
  const onAroundWidths = useCallback(
    (next: AroundWidths) =>
      setAround((current) =>
        current !== null &&
        current.width === next.width &&
        current.freed.join() === next.freed.join()
          ? current
          : next,
      ),
    [],
  );
  const barRoom = useBarTitleRoom();
  const besideAround =
    (hasEnd && glass ? 2 * barGlassInset : 0) + (foldedRunId === null ? 0 : foldedPageWidth);
  const measured = aroundInRow ? around : null;
  const yielded =
    measured === null || need === null
      ? 0
      : barYield({
          freed: measured.freed,
          need,
          room: barRoom,
          trailing: besideAround + measured.width,
        });
  const maxWidth = barTitleWidth(
    barRoom,
    besideAround +
      (measured === null
        ? 0
        : measured.freed.slice(0, yielded).reduce((left, freed) => left - freed, measured.width)),
  );
  const { deploymentId, hostClient, threadId } = props;
  const openPlace = useOpenPlace(deploymentId, threadId);
  useLayoutEffect(() => {
    const openAround = () => navigation.navigate("ThreadAround", { deploymentId, threadId });
    navigation.setOptions(
      aroundHeaderOptions(
        !hasEnd ? null : (
          <View style={styles.end}>
            {foldedRunId === null ? null : (
              <FoldedPage
                hostClient={hostClient}
                onOpen={(destination: TabDestination) => openPlace(destination)}
                onUnfold={() =>
                  updatePage((value) => ({
                    ...value,
                    memory: runPageOpened(foldedRunId, value.memory),
                  }))
                }
                room={room}
                runId={foldedRunId}
                threadId={threadId}
              />
            )}
            {!aroundInRow || glance === null ? null : (
              <AroundButton
                glance={glance}
                onWidths={onAroundWidths}
                yielded={yielded}
                onPress={openAround}
              />
            )}
          </View>
        ),
        verticalBar && glance !== null ? nativeHeaderItem(aroundBarItem(glance, openAround)) : null,
      ),
    );
  }, [
    aroundInRow,
    deploymentId,
    foldedRunId,
    glance,
    hasEnd,
    hostClient,
    navigation,
    onAroundWidths,
    openPlace,
    room,
    threadId,
    updatePage,
    verticalBar,
    yielded,
  ]);
  // Done on the task in view moves on to the next one, while it is still in view.
  const onMarkedDone = (next: string | null) => {
    const state = navigation.getState();
    if (
      state === undefined ||
      !navigation.isFocused() ||
      listedRowThreadId(hostClient.getSnapshot(), threadId) !== threadId
    )
      return;
    const action = openTopLevel(
      state,
      next === null
        ? { name: "Home", params: { deploymentId } }
        : { name: "Thread", params: { deploymentId, threadId: next } },
    );
    if (action !== null) navigation.dispatch(action);
  };
  return (
    <ThreadTitlePill
      {...props}
      maxWidth={maxWidth}
      onMarkedDone={onMarkedDone}
      onNeed={setNeed}
      onFind={() => navigation.navigate("ThreadFind", { deploymentId, threadId })}
    />
  );
}

/**
 * The conversation's mark and name, where it stands, and its menu.
 *
 * Liquid Glass draws them as one capsule beside the bar's others: the state
 * shrinks to its mark, and its word and place move to the menu's heading.
 * Elsewhere the two lines stay, and Android's menu has no heading to move to.
 * A pill floating over a transcript with no bar under it, as beside a page,
 * is always the capsule: where there is no glass, it wears the opaque float.
 */
export function ThreadTitlePill(
  props: ThreadHeaderState & {
    readonly deploymentId: string;
    /** More the menu offers where the pill is drawn, after the conversation's own. */
    readonly extraActions?: readonly NativeMenuOption[];
    readonly floating?: boolean;
    readonly hostClient: HostClient;
    readonly maxWidth: number;
    readonly onFind: () => void;
    readonly onMarkedDone?: (next: string | null) => void;
    /** Hears how wide the title has to be to say the name whole, or to its floor. */
    readonly onNeed?: (width: number) => void;
    readonly onOpenThread: (threadId: string) => void;
    readonly threadId: string;
  },
): ReactNode {
  const glass = useLiquidGlass();
  const { deploymentId, onNeed, threadId } = props;
  // Stop asked from the menu says how it went where the task's state is.
  const stopLine = useAssignmentStopLine(
    props.hostClient,
    props.task === null
      ? null
      : { assignmentId: props.task.assignmentId, open: props.task.open, title: props.title },
  );
  const width = props.maxWidth;
  // All of the title but its words is fixed, so it needs that plus what the name needs.
  const sizes = useRef({ name: NaN, title: NaN, words: NaN });
  const report = (part: keyof typeof sizes.current, size: number) => {
    sizes.current[part] = size;
    const need = sizes.current.title - sizes.current.words + sizes.current.name;
    if (Number.isFinite(need)) onNeed?.(need);
  };
  const measure =
    onNeed === undefined
      ? () => ({})
      : (part: keyof typeof sizes.current) => ({
          onLayout: (event: LayoutChangeEvent) => report(part, event.nativeEvent.layout.width),
        });
  const name = (
    <ThreadName
      maxFontSizeMultiplier={headerFontScaleLimit}
      numberOfLines={1}
      {...(onNeed === undefined ? {} : { onNeed: (size: number) => report("name", size) })}
      title={props.title}
      icon={props.icon}
      color={props.color}
      isVoice={props.isVoice}
    />
  );
  const menu = (children: ReactNode, maxWidth: number) => (
    <ThreadMenu
      connectionLabel={props.connectionLabel}
      deploymentId={deploymentId}
      extraActions={props.extraActions ?? []}
      hostClient={props.hostClient}
      maxWidth={maxWidth}
      onFind={props.onFind}
      {...(props.onMarkedDone ? { onMarkedDone: props.onMarkedDone } : {})}
      onOpenThread={props.onOpenThread}
      task={props.task}
      threadId={threadId}
      title={props.title}
    >
      {children}
    </ThreadMenu>
  );
  if (glass || props.floating === true)
    return (
      <GlassSurface
        interactive
        shape="capsule"
        style={[styles.capsule, { maxWidth: width }]}
        {...measure("title")}
      >
        {menu(
          <>
            <View style={styles.words} {...measure("words")}>
              {name}
              {/* The one state worth a second line: nothing will answer until it is back. */}
              {props.connectionLabel === null && stopLine === null ? null : (
                <ThreadSubtitle
                  connectionLabel={props.connectionLabel}
                  line={stopLine}
                  task={null}
                />
              )}
            </View>
            {props.task === null ? null : (
              <TaskStateIndicator moving={props.task.moving} tone={props.task.tone} />
            )}
          </>,
          width - 2 * capsuleInset,
        )}
      </GlassSurface>
    );
  return (
    <View style={[styles.title, { maxWidth: width }]} {...measure("title")}>
      {menu(
        <View style={styles.words} {...measure("words")}>
          {name}
          <ThreadSubtitle
            connectionLabel={props.connectionLabel}
            line={stopLine}
            // iOS says "Completed" in the menu's heading and its accessible
            // name, so the bar keeps one line for the title. Android's menu
            // has no heading, and every other state stays here.
            task={Platform.OS === "ios" && props.task?.tone === "completed" ? null : props.task}
          />
        </View>,
        width,
      )}
    </View>
  );
}

const capsuleInset = space[12];

const styles = StyleSheet.create({
  capsule: { paddingHorizontal: capsuleInset },
  end: { alignItems: "center", flexDirection: "row" },
  title: { alignItems: "center", flexDirection: "row", gap: space[4] },
  // Material's title leads; iOS centres it in the bar.
  words: { alignItems: Platform.OS === "android" ? "flex-start" : "center", flexShrink: 1 },
});
