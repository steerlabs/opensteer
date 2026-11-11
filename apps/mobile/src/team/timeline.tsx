import { useCallback, useMemo, useRef, type ReactNode } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import {
  AgentCardRow,
  DayPill,
  MessageRow,
  NewLine,
  SystemLine,
  wordsInset,
  type MessageRowActions,
} from "./message-row.js";
import type { StatusFace } from "./status-words.js";
import { PeopleOnlyBadge, peopleOnlySentence } from "./team-marks.js";
import type { JumpView, TimelineItem } from "./team-models.js";

/** Within this many points of the newest message, the list follows what arrives. */
export const followDistance = 80;

export interface TimelineActions extends MessageRowActions {
  readonly onCardAction: (
    requestId: string,
    action: NonNullable<StatusFace["action"]>["kind"],
  ) => void;
  readonly onOpenCardTask: (requestId: string) => void;
  readonly onJump: () => void;
  /** Older pages, when the reader scrolls to the top of what is loaded. */
  readonly onLoadOlder: () => void;
  /** The reader is (or is no longer) within `followDistance` of the newest message. */
  readonly onFollowingChange: (following: boolean) => void;
}

/**
 * A channel's, DM's or thread's messages, newest at the bottom.
 *
 * The list is inverted, so the newest message is its first row and loading an
 * older page appends far above the reader: nothing under the eye moves. A
 * status card turning into its reply is replaced in place. The space for the
 * typing line is always reserved, so someone starting to type never nudges the
 * last message.
 */
export function Timeline(props: {
  readonly actions: TimelineActions;
  /** Oldest first, as the reader reads them. */
  readonly items: readonly TimelineItem[];
  /** Shown above the oldest message once there is nothing older. */
  readonly intro: ReactNode;
  readonly jump: JumpView | null;
  /** Points the floating composer covers at the bottom. */
  readonly clearance: number;
  /** "Leo is typing"; the line is held empty when nobody is. */
  readonly typing: string | null;
}): ReactNode {
  const { actions } = props;
  const newestFirst = useMemo(() => [...props.items].reverse(), [props.items]);
  const following = useRef(true);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const near = event.nativeEvent.contentOffset.y <= followDistance;
      if (near !== following.current) {
        following.current = near;
        actions.onFollowingChange(near);
      }
    },
    [actions],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TimelineItem>) => <TimelineRow actions={actions} item={item} />,
    [actions],
  );
  return (
    <View style={styles.fill}>
      <FlatList
        // The typing line sits under the newest message, inside the list, so
        // it scrolls with it and its height is always there.
        ListFooterComponent={<>{props.intro}</>}
        ListHeaderComponent={<TypingLine clearance={props.clearance} text={props.typing} />}
        data={newestFirst}
        inverted
        keyExtractor={itemKey}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        maxToRenderPerBatch={12}
        onEndReached={actions.onLoadOlder}
        onEndReachedThreshold={0.6}
        onScroll={onScroll}
        renderItem={renderItem}
        scrollEventThrottle={100}
        windowSize={9}
      />
      {props.jump === null ? null : (
        <JumpPill bottom={props.clearance + space[8]} jump={props.jump} onPress={actions.onJump} />
      )}
    </View>
  );
}

function itemKey(item: TimelineItem): string {
  switch (item.kind) {
    case "message":
      return `m:${item.message.id}`;
    case "card":
      return `c:${item.card.id}`;
    default:
      return `${item.kind}:${item.id}`;
  }
}

function TimelineRow(props: {
  readonly actions: TimelineActions;
  readonly item: TimelineItem;
}): ReactNode {
  const { actions, item } = props;
  switch (item.kind) {
    case "day":
      return (
        <View style={styles.inset}>
          <DayPill label={item.label} />
        </View>
      );
    case "new":
      return (
        <View style={styles.inset}>
          <NewLine />
        </View>
      );
    case "system":
      return <SystemLine text={item.text} />;
    case "message":
      return <MessageRow actions={actions} message={item.message} />;
    case "card":
      return (
        <AgentCardRow
          card={item.card}
          onAction={actions.onCardAction}
          onOpenTask={actions.onOpenCardTask}
        />
      );
  }
}

/** One reserved line under the newest message. */
function TypingLine(props: {
  readonly clearance: number;
  readonly text: string | null;
}): ReactNode {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.typing, { marginBottom: props.clearance }]}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        tone="muted"
      >
        {props.text ?? " "}
      </AppText>
    </View>
  );
}

/** "6 new ↑" above the view, "3 new ↓" below it: one glass pill, never a modal. */
export function JumpPill(props: {
  readonly bottom: number;
  readonly jump: JumpView;
  readonly onPress: () => void;
}): ReactNode {
  const up = props.jump.direction === "up";
  return (
    <View
      pointerEvents="box-none"
      style={[styles.jumpLane, up ? styles.jumpTop : { bottom: props.bottom }]}
    >
      <Pressable
        accessibilityLabel={`${props.jump.label}, ${up ? "go to the first unread" : "go to the newest"}`}
        accessibilityRole="button"
        onPress={props.onPress}
      >
        <GlassSurface interactive shape="capsule" style={styles.jump} tint={color.floatTint}>
          <Symbol
            name={up ? "arrow.up" : "arrow.down"}
            size={13}
            tint={color.ember}
            weight="semibold"
          />
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="caption"
            style={styles.jumpLabel}
          >
            {props.jump.label}
          </AppText>
        </GlassSurface>
      </Pressable>
    </View>
  );
}

/**
 * The start of a channel: what it is for, and the instructions every agent
 * run from here is given. Everyone here can read them.
 */
export function ChannelIntro(props: {
  readonly description: string | null;
  readonly instructions: string | null;
  readonly peopleOnly: boolean;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.intro}>
      <AppText role="title">{props.title}</AppText>
      {props.description === null ? null : (
        <AppText role="secondary" tone="soft">
          {props.description}
        </AppText>
      )}
      {props.peopleOnly ? (
        <View style={styles.introPeopleOnly}>
          <PeopleOnlyBadge />
          <AppText role="caption" tone="muted">
            Agents can't be asked, read or search here. {peopleOnlySentence}
          </AppText>
        </View>
      ) : props.instructions === null ? null : (
        <View style={styles.instructions}>
          <View style={styles.instructionsHead}>
            <Symbol name="sparkles" size={13} tint={color.muted} />
            <AppText role="caption" style={styles.instructionsLabel}>
              Instructions for agents
            </AppText>
          </View>
          <AppText numberOfLines={4} role="secondary" tone="soft">
            {props.instructions}
          </AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  inset: { paddingHorizontal: space[14] },
  instructions: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    marginTop: space[6],
    padding: space[12],
  },
  instructionsHead: { alignItems: "center", flexDirection: "row", gap: space[6] },
  instructionsLabel: { color: color.muted, fontWeight: "600" },
  intro: {
    gap: space[4],
    paddingBottom: space[12],
    paddingHorizontal: space[14],
    paddingTop: space[24],
  },
  introPeopleOnly: { gap: space[6], marginTop: space[6] },
  jump: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    minHeight: 36,
    paddingHorizontal: space[14],
  },
  jumpLabel: { color: color.text, fontWeight: "600" },
  jumpLane: { alignItems: "center", left: 0, position: "absolute", right: 0 },
  jumpTop: { top: space[8] },
  typing: {
    justifyContent: "center",
    minHeight: touchTarget - 16,
    paddingLeft: space[14] + wordsInset,
  },
});
