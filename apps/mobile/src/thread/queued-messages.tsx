import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { queuedMessages, type HostClient, type QueuedMessage } from "@opensteer/client/host";
import type { ArtifactContentPart, ThreadInputQueue } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import Animated, {
  FadeOutDown,
  FadeOutUp,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { operationDetail } from "../client/mobile-client.js";
import { color, material, radius, space, touchTarget, type } from "../theme.js";
import { duration, enter, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/** Past this many cards the middle folds into a stack, so the tray leaves the thread visible. */
const collapseAfter = 3;
/** How long a press is held before the card lifts to be moved. */
const liftDelay = 280;
const settle = 180;

type Exit = "down" | "side" | "up";

interface Lifted {
  readonly height: number;
  readonly id: string;
  /** The order being shown while the card is held: the queue as it would be if dropped now. */
  readonly order: readonly string[];
  /** Every card's centre when the card was lifted, so crossing one is measured against where it was. */
  readonly centres: ReadonlyMap<string, number>;
  readonly start: readonly string[];
  readonly top: number;
}

/**
 * The messages waiting behind the current turn, docked on the composer.
 *
 * Each message is its own card, numbered in the order Runs will take them;
 * the one the next Run takes is filled in. Only people's messages appear (see
 * `queuedMessages`), with up to three lines of their words so a phone shows
 * what was said rather than a truncated line to be opened.
 *
 * Hold a card to lift it and drag it to a new place; the others make room as
 * it passes them. Swipe a card left to remove it. Its menu steers it into the
 * current turn, takes it back into the composer to be edited, or removes it.
 * VoiceOver reaches every one of these as an action on the card.
 */
export function QueuedMessages(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  /**
   * Puts a message taken back from the queue into the composer to be
   * reworded: its words, and its files by reference to the Host's copies.
   */
  readonly onEdit: (message: {
    readonly attachments: readonly ArtifactContentPart[];
    readonly text: string;
  }) => void;
  readonly queue: ThreadInputQueue;
}): ReactNode {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [lifted, setLifted] = useState<Lifted | null>(null);
  const layouts = useRef(new Map<string, { readonly height: number; readonly y: number }>());
  const listHeight = useRef(0);
  const exits = useRef(new Map<string, Exit>());
  const offset = useSharedValue(0);
  const liftedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }, { scale: 1.02 }],
  }));

  const shown = queuedMessages(props.queue);
  const byId = new Map<string, QueuedMessage>(
    shown.map((message) => [message.item.message.id, message]),
  );
  const ids: string[] = shown.map(({ item }) => item.message.id);
  const collapsed = !expanded && lifted === null && shown.length > collapseAfter;
  // The first shown card is filled in only when the next Run really takes it.
  const firstIsNext = shown[0]?.next === true;
  if (!props.queue.paused && shown.length === 0) return null;

  const act = async (
    messageId: string,
    exitAs: Exit | null,
    run: () => Promise<void>,
    fallback: string,
  ): Promise<void> => {
    if (busyId !== null || !props.canRespond) return;
    setBusyId(messageId);
    setFailure(null);
    if (exitAs) exits.current.set(messageId, exitAs);
    try {
      await run();
      void Haptics.selectionAsync();
    } catch (error) {
      exits.current.delete(messageId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFailure(operationDetail(error, fallback));
    } finally {
      setBusyId(null);
    }
  };

  const steer = (id: string) =>
    void act(
      id,
      "up",
      () => props.hostClient.steerThreadInput(props.queue.threadId, id),
      "That message could not be steered into the current run.",
    );
  const edit = (message: QueuedMessage) =>
    void act(
      message.item.message.id,
      "down",
      async () => {
        await props.hostClient.cancelThreadInput(props.queue.threadId, message.item.message.id);
        const { content } = message.item.message;
        props.onEdit({
          attachments: content.flatMap((part) => (part.type === "artifact" ? [part] : [])),
          text: content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim(),
        });
      },
      "That message could not be taken back to edit.",
    );
  const remove = (id: string, exitAs: Exit) =>
    void act(
      id,
      exitAs,
      () => props.hostClient.cancelThreadInput(props.queue.threadId, id),
      "That message could not be removed from the queue.",
    );
  // A card placed among the shown messages stands in front of the one that
  // now follows it, or at the back of the queue when none does.
  const move = (id: string, order: readonly string[]) => {
    const at = order.indexOf(id);
    void act(
      id,
      null,
      () => props.hostClient.moveThreadInput(props.queue.threadId, id, order[at + 1] ?? null),
      "That message could not be moved.",
    );
  };
  const nudge = (id: string, by: -1 | 1) => {
    const to = ids.indexOf(id) + by;
    if (to < 0 || to >= ids.length) return;
    move(id, placeAt(ids, id, to));
  };

  const lift = (id: string): boolean => {
    if (busyId !== null || !props.canRespond || lifted !== null) return false;
    if (collapsed) {
      setExpanded(true);
      return false;
    }
    const layout = layouts.current.get(id);
    if (!layout) return false;
    const centres = new Map<string, number>();
    for (const candidate of ids) {
      const measured = layouts.current.get(candidate);
      if (measured) centres.set(candidate, measured.y + measured.height / 2);
    }
    offset.value = 0;
    setLifted({ centres, height: layout.height, id, order: ids, start: ids, top: layout.y });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    return true;
  };

  const drag = (pulled: number) => {
    if (!lifted) return;
    // The held card stays inside the tray; past its edge there is nowhere to go.
    const dy = Math.max(
      -lifted.top,
      Math.min(listHeight.current - lifted.top - lifted.height, pulled),
    );
    offset.value = dy;
    // Rising, the card passes a neighbour once its top edge crosses that
    // neighbour's centre; sinking, once its bottom edge does. Its own centre
    // would keep a tall card from ever reaching the top of the tray.
    const top = lifted.top + dy;
    const from = lifted.start.indexOf(lifted.id);
    let to = from;
    for (const [index, id] of lifted.start.entries()) {
      const centre = lifted.centres.get(id);
      if (centre === undefined || index === from) continue;
      if (index < from && top < centre) to -= 1;
      if (index > from && top + lifted.height > centre) to += 1;
    }
    const order = placeAt(lifted.start, lifted.id, to);
    if (order.join() === lifted.order.join()) return;
    setLifted({ ...lifted, order });
    void Haptics.selectionAsync();
  };

  const drop = () => {
    if (!lifted) return;
    // The held card settles onto the place its gap has moved to, and only
    // then does the queue take the order, so nothing jumps when it lands.
    const target = layouts.current.get(lifted.id);
    offset.value = withTiming(target ? target.y - lifted.top : 0, { duration: settle });
    const { id, order, start } = lifted;
    setTimeout(() => {
      if (order.join() !== start.join()) move(id, order);
      setLifted(null);
    }, settle);
  };

  // While a card is held the list shows where it would land. Anything the
  // queue gained or lost meanwhile is honoured rather than drawn from memory.
  const order = lifted
    ? [
        ...lifted.order.filter((id) => byId.has(id)),
        ...ids.filter((id) => !lifted.order.includes(id)),
      ]
    : ids;
  const heldFace = lifted ? byId.get(lifted.id) : undefined;

  const card = (id: string, position: number) => {
    const message = byId.get(id);
    if (!message) return null;
    // A swiped card has already left; the others lift toward the conversation
    // or drop back into the composer, as their exit says.
    const exitAs = exits.current.get(id);
    const leaving =
      exitAs === "side"
        ? {}
        : {
            exiting:
              exitAs === "down"
                ? FadeOutDown.duration(duration.exit)
                : FadeOutUp.duration(duration.exit),
          };
    return (
      <Animated.View
        {...leaving}
        entering={enter}
        key={id}
        layout={LinearTransition.duration(duration.enter)}
        onLayout={(event) => {
          const { height, y } = event.nativeEvent.layout;
          layouts.current.set(id, { height, y });
        }}
        style={lifted?.id === id ? styles.gap : undefined}
      >
        <QueueCard
          blocked={busyId !== null || !props.canRespond}
          busy={busyId === id}
          count={shown.length}
          message={message}
          next={firstIsNext && position === 0}
          onDrag={drag}
          onDrop={drop}
          onEdit={() => edit(message)}
          onLift={() => lift(id)}
          onNudge={(by) => nudge(id, by)}
          onRemove={(exitAs) => remove(id, exitAs)}
          onSteer={() => steer(id)}
          position={position}
        />
      </Animated.View>
    );
  };

  return (
    <Animated.View
      accessibilityLabel="Queued messages"
      entering={enter}
      exiting={exit}
      style={styles.tray}
    >
      <View style={styles.head}>
        {props.queue.paused ? <View style={styles.pausedDot} /> : null}
        <AppText
          role="caption"
          style={props.queue.paused ? styles.pausedLabel : undefined}
          tone={props.queue.paused ? "default" : "muted"}
        >
          {props.queue.paused ? "Paused" : "Queued"}
        </AppText>
        {shown.length > 0 ? (
          <AppText role="caption" tone="soft">
            {shown.length}
          </AppText>
        ) : null}
        <View style={styles.spacer} />
        {expanded && shown.length > collapseAfter ? (
          <Pressable
            accessibilityLabel="Fold the queue"
            accessibilityRole="button"
            hitSlop={space[8]}
            onPress={() => setExpanded(false)}
            style={({ pressed }) => [styles.headAction, pressed && styles.pressed]}
          >
            <Symbol name="chevron.down" size={13} tint={color.muted} weight="semibold" />
          </Pressable>
        ) : null}
        {props.queue.paused ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: resuming, disabled: resuming || !props.canRespond }}
            disabled={resuming || !props.canRespond}
            hitSlop={space[8]}
            onPress={() => {
              if (resuming) return;
              setResuming(true);
              setFailure(null);
              props.hostClient
                .resumeThreadInputQueue(props.queue.threadId)
                .catch((error: unknown) =>
                  setFailure(operationDetail(error, "The queue could not be resumed.")),
                )
                .finally(() => setResuming(false));
            }}
            style={({ pressed }) => [styles.headAction, pressed && styles.pressed]}
          >
            {resuming ? (
              <ActivityIndicator color={color.ember} size="small" />
            ) : (
              <AppText role="secondaryMedium" tone="ember">
                Resume
              </AppText>
            )}
          </Pressable>
        ) : null}
      </View>
      {shown.length > 0 ? (
        <View
          onLayout={(event) => {
            listHeight.current = event.nativeEvent.layout.height;
          }}
          style={styles.list}
        >
          {collapsed ? (
            <>
              {card(ids[0]!, 0)}
              <Pressable
                accessibilityLabel={`Show ${shown.length - 2} more queued messages`}
                accessibilityRole="button"
                onPress={() => setExpanded(true)}
                style={({ pressed }) => [styles.stack, pressed && styles.pressed]}
              >
                <AppText role="caption" tone="muted">
                  +{shown.length - 2} more
                </AppText>
              </Pressable>
              {card(ids.at(-1)!, shown.length - 1)}
            </>
          ) : (
            order.map((id, position) => card(id, position))
          )}
          {lifted && heldFace ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.held, { height: lifted.height, top: lifted.top }, liftedStyle]}
            >
              <CardFace
                busy={false}
                lifted
                message={heldFace}
                next={firstIsNext && order[0] === lifted.id}
                position={order.indexOf(lifted.id)}
              />
            </Animated.View>
          ) : null}
        </View>
      ) : null}
      {failure === null ? null : (
        <View accessibilityRole="alert" style={styles.failure}>
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        </View>
      )}
    </Animated.View>
  );
}

/**
 * One card and its gestures. A press held for `liftDelay` lifts it to be
 * moved; a horizontal pull before that is a swipe, and a vertical one before
 * that is left alone. The menu sits outside the gesture so a tap on it is
 * always a tap.
 */
function QueueCard(props: {
  readonly blocked: boolean;
  readonly busy: boolean;
  readonly count: number;
  readonly message: QueuedMessage;
  readonly next: boolean;
  readonly onDrag: (dy: number) => void;
  readonly onDrop: () => void;
  readonly onEdit: () => void;
  readonly onLift: () => boolean;
  readonly onNudge: (by: -1 | 1) => void;
  readonly onRemove: (exitAs: Exit) => void;
  readonly onSteer: () => void;
  readonly position: number;
}): ReactNode {
  const { item, text } = props.message;
  const swipe = useSharedValue(0);
  const width = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const swipeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: swipe.value }] }));
  const revealStyle = useAnimatedStyle(() => ({ opacity: swipe.value < -4 ? 1 : 0 }));
  const gesture = useRef<{
    mode: "held" | "idle" | "lifted" | "swiping";
    timer: ReturnType<typeof setTimeout> | null;
  }>({ mode: "idle", timer: null });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => {
        const current = latest.current;
        return !current.blocked && (current.message.item.canMove || current.message.item.canCancel);
      },
      onPanResponderGrant: () => {
        const state = gesture.current;
        state.mode = "held";
        state.timer = setTimeout(() => {
          state.timer = null;
          if (state.mode !== "held") return;
          state.mode =
            latest.current.message.item.canMove && latest.current.onLift() ? "lifted" : "idle";
        }, liftDelay);
      },
      onPanResponderMove: (_event: GestureResponderEvent, move: PanResponderGestureState) => {
        const state = gesture.current;
        if (state.mode === "lifted") {
          latest.current.onDrag(move.dy);
          return;
        }
        if (state.mode === "swiping") {
          swipe.value = Math.min(0, move.dx);
          return;
        }
        if (state.mode !== "held") return;
        if (
          latest.current.message.item.canCancel &&
          move.dx < -10 &&
          Math.abs(move.dx) > Math.abs(move.dy)
        ) {
          stopTimer(state);
          state.mode = "swiping";
        } else if (Math.abs(move.dy) > 10 || Math.abs(move.dx) > 10) {
          stopTimer(state);
          state.mode = "idle";
        }
      },
      onPanResponderRelease: (_event, move) => finish(move),
      onPanResponderTerminate: (_event, move) => finish(move),
      onPanResponderTerminationRequest: () =>
        gesture.current.mode !== "lifted" && gesture.current.mode !== "swiping",
    }),
  ).current;

  function finish(move: PanResponderGestureState) {
    const state = gesture.current;
    stopTimer(state);
    const mode = state.mode;
    state.mode = "idle";
    if (mode === "lifted") latest.current.onDrop();
    if (mode !== "swiping") return;
    if (move.dx < -width.current * 0.35 || move.vx < -0.8) {
      swipe.value = withTiming(-width.current, { duration: settle });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      latest.current.onRemove("side");
    } else {
      swipe.value = withTiming(0, { duration: settle });
    }
  }

  const actions: MenuAction[] = [
    ...(item.canSteer
      ? [{ id: "steer", image: "arrow.turn.down.right", title: "Steer into this turn" } as const]
      : []),
    ...(item.canCancel
      ? [
          { id: "edit", image: "pencil", title: "Edit" } as const,
          {
            attributes: { destructive: true },
            id: "remove",
            image: "trash",
            title: "Remove",
          } as const,
        ]
      : []),
  ];
  const onAction = (action: string) => {
    if (action === "steer") props.onSteer();
    else if (action === "edit") props.onEdit();
    else if (action === "remove") props.onRemove("up");
  };
  const accessibilityActions = [
    ...(item.canMove && props.position > 0 ? [{ label: "Move earlier", name: "earlier" }] : []),
    ...(item.canMove && props.position < props.count - 1
      ? [{ label: "Move later", name: "later" }]
      : []),
    ...actions.map(({ id, title }) => ({ label: title, name: id ?? title })),
  ];

  return (
    <View
      onLayout={(event) => {
        width.current = event.nativeEvent.layout.width;
      }}
    >
      <Animated.View style={[styles.reveal, revealStyle]}>
        <Symbol name="trash" size={16} tint={color.text} />
        <AppText role="secondaryMedium">Remove</AppText>
      </Animated.View>
      <Animated.View
        accessibilityActions={accessibilityActions}
        accessibilityHint={item.canMove ? "Hold and drag to move it." : undefined}
        accessibilityLabel={`Queued message ${props.position + 1} of ${props.count}: ${text}`}
        accessible
        onAccessibilityAction={(event: AccessibilityActionEvent) => {
          const name = event.nativeEvent.actionName;
          if (name === "earlier") props.onNudge(-1);
          else if (name === "later") props.onNudge(1);
          else onAction(name);
        }}
        style={swipeStyle}
      >
        <View style={styles.row}>
          <View {...responder.panHandlers} style={styles.body}>
            <CardFace
              busy={props.busy}
              lifted={false}
              message={props.message}
              next={props.next}
              position={props.position}
            />
          </View>
          {actions.length > 0 && !props.busy ? (
            <MenuView
              actions={actions}
              colorScheme="dark"
              onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
              style={styles.menu}
            >
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.menuTrigger}
              >
                <Symbol name="ellipsis" size={17} tint={color.muted} />
              </View>
            </MenuView>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

/** What a card looks like, held or at rest: its place in line and up to three lines of words. */
function CardFace(props: {
  readonly busy: boolean;
  readonly lifted: boolean;
  readonly message: QueuedMessage;
  readonly next: boolean;
  readonly position: number;
}): ReactNode {
  const files = props.message.item.message.content.filter(
    (part) => part.type === "artifact",
  ).length;
  return (
    <View style={[styles.face, props.lifted && styles.faceLifted]}>
      <View style={[styles.ordinal, props.next && styles.ordinalNext]}>
        <AppText
          maxFontSizeMultiplier={1.3}
          role="caption"
          style={props.next ? styles.ordinalNextText : styles.ordinalText}
        >
          {props.position + 1}
        </AppText>
      </View>
      <AppText numberOfLines={3} role="secondary" style={styles.text}>
        {props.message.text}
      </AppText>
      {files > 0 ? (
        <AppText role="caption" tone="muted">
          {files === 1 ? "1 file" : `${files} files`}
        </AppText>
      ) : null}
      {props.busy ? <ActivityIndicator color={color.muted} size="small" /> : null}
    </View>
  );
}

function stopTimer(state: { timer: ReturnType<typeof setTimeout> | null }): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
}

function placeAt(order: readonly string[], id: string, to: number): string[] {
  const arranged = order.filter((candidate) => candidate !== id);
  arranged.splice(to, 0, id);
  return arranged;
}

/** How far the tray tucks under the composer's top edge, so the two read as one dock. */
const overlap = space[12];

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0 },
  face: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingLeft: space[10],
    paddingRight: space[4],
    paddingVertical: space[10],
  },
  faceLifted: {
    ...material.float,
    borderRadius: radius.md,
    // Room for the menu the card at rest carries, so its words wrap the same.
    paddingRight: touchTarget,
  },
  failure: { paddingHorizontal: space[14], paddingTop: space[8] },
  // The held card's own slot, kept open and empty while it is carried.
  gap: { opacity: 0 },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    minHeight: 36,
    paddingLeft: space[14],
    paddingRight: space[8],
  },
  headAction: {
    justifyContent: "center",
    minHeight: touchTarget - space[8],
    paddingHorizontal: space[6],
  },
  held: { left: 0, position: "absolute", right: 0 },
  list: { gap: space[6], paddingHorizontal: space[6] },
  menu: { alignSelf: "stretch" },
  menuTrigger: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget - space[4],
  },
  ordinal: {
    alignItems: "center",
    borderColor: color.lineHover,
    borderRadius: radius.full,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    marginTop: 1,
    width: 22,
  },
  ordinalNext: { backgroundColor: color.text, borderColor: color.text },
  ordinalNextText: { color: color.surface, fontVariant: ["tabular-nums"], fontWeight: "600" },
  ordinalText: { color: color.muted, fontVariant: ["tabular-nums"] },
  pausedDot: { backgroundColor: color.amber, borderRadius: radius.full, height: 6, width: 6 },
  pausedLabel: { color: color.amber },
  pressed: { opacity: 0.6 },
  // What a swipe uncovers: the one thing letting go will do.
  reveal: {
    alignItems: "center",
    backgroundColor: color.red,
    borderRadius: radius.md,
    bottom: 0,
    flexDirection: "row",
    gap: space[6],
    justifyContent: "flex-end",
    left: 0,
    paddingRight: space[16],
    position: "absolute",
    right: 0,
    top: 0,
  },
  row: {
    ...material.plate,
    alignItems: "flex-start",
    borderRadius: radius.md,
    flexDirection: "row",
  },
  spacer: { flex: 1 },
  stack: {
    ...material.plate,
    alignItems: "center",
    alignSelf: "center",
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    borderTopWidth: 0,
    height: 22,
    justifyContent: "center",
    marginTop: -space[6],
    width: "92%",
  },
  text: { ...type.secondary, color: color.text, flex: 1, minWidth: 0 },
  // The surface is a step below the composer's glass and its bottom edge is
  // hidden under it, so the corners that show are the only ones drawn.
  tray: {
    ...material.plate,
    borderBottomWidth: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    marginBottom: -overlap,
    overflow: "hidden",
    paddingBottom: overlap + space[6],
  },
});
