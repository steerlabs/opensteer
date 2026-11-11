import { useHostSelector, useRunPageView } from "@opensteer/client/react";
import { runPageOpened, type HostClient, type SurfaceDestination } from "@opensteer/client/host";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { headerFontScaleLimit, space } from "../theme.js";
import {
  AroundButton,
  aroundHeaderOptions,
  barOverContentOptions,
  type AroundWidths,
} from "../thread/around-button.js";
import { aroundGlanceSelector, sameAroundGlance } from "../thread/around-model.js";
import { FoldedPage, foldedPageWidth } from "../thread/folded-page.js";
import { surfaceRoute } from "../browser/surface-route.js";
import { sameThreadHeader, type ThreadHeaderState } from "../thread/thread-pane.js";
import { TaskStateIndicator } from "../thread/task-status.js";
import type { NativeMenuOption } from "../thread/composer-menu.js";
import { ThreadMenu } from "../thread/thread-menu.js";
import { ThreadName, ThreadSubtitle } from "../thread/thread-subtitle.js";
import { AppText } from "../ui/primitives.js";
import { barGlassInset, barTitleWidth, barYield, useBarTitleRoom } from "../ui/bar-title.js";
import { GlassSurface, useLiquidGlass } from "../ui/glass.js";
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
                  placeKind={null}
                  placeName={null}
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
  const selectAround = useMemo(() => aroundGlanceSelector(props.threadId), [props.threadId]);
  const glance = useHostSelector(props.hostClient, selectAround, sameAroundGlance);
  // A folded page stands beside Around; the title takes what they leave, and
  // when that is short of its name, Around gives up parts until it is not.
  const [page, updatePage] = useRunPageView(props.hostClient, props.threadId);
  const foldedRunId = page.shown === "folded" ? page.runId : null;
  const room = page.room;
  const hasEnd = glance !== null || foldedRunId !== null;
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
  const measured = glance === null ? null : around;
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
  useLayoutEffect(() => {
    navigation.setOptions(
      aroundHeaderOptions(
        !hasEnd ? null : (
          <View style={styles.end}>
            {foldedRunId === null ? null : (
              <FoldedPage
                hostClient={hostClient}
                onOpen={(destination: SurfaceDestination) =>
                  navigation.dispatch(
                    StackActions.push(
                      "WorkspaceBrowser",
                      surfaceRoute(deploymentId, threadId, destination),
                    ),
                  )
                }
                onUnfold={() =>
                  updatePage((value) => ({
                    ...value,
                    memory: runPageOpened(foldedRunId),
                  }))
                }
                room={room}
                runId={foldedRunId}
                threadId={threadId}
              />
            )}
            {glance === null ? null : (
              <AroundButton
                glance={glance}
                onWidths={onAroundWidths}
                yielded={yielded}
                onPress={() => navigation.navigate("ThreadAround", { deploymentId, threadId })}
              />
            )}
          </View>
        ),
      ),
    );
  }, [
    deploymentId,
    foldedRunId,
    glance,
    hasEnd,
    hostClient,
    navigation,
    onAroundWidths,
    room,
    threadId,
    updatePage,
    yielded,
  ]);
  return (
    <ThreadTitlePill
      {...props}
      maxWidth={maxWidth}
      onNeed={setNeed}
      onFind={() => navigation.navigate("ThreadFind", { deploymentId, threadId })}
    />
  );
}

/**
 * The conversation's mark and name, where it stands, and its menu.
 *
 * Liquid Glass draws them as one capsule beside the bar's others: the state
 * shrinks to its mark, and its word and project move to the menu's heading.
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
    /** Hears how wide the title has to be to say the name whole, or to its floor. */
    readonly onNeed?: (width: number) => void;
    readonly onOpenThread: (threadId: string) => void;
    readonly threadId: string;
  },
): ReactNode {
  const glass = useLiquidGlass();
  const { deploymentId, onNeed, threadId } = props;
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
      onOpenThread={props.onOpenThread}
      placeName={props.placeName}
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
              {props.connectionLabel === null ? null : (
                <ThreadSubtitle
                  connectionLabel={props.connectionLabel}
                  placeKind={null}
                  placeName={null}
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
            placeName={props.placeName}
            placeKind={props.placeKind}
            connectionLabel={props.connectionLabel}
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
