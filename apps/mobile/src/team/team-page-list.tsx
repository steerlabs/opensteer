import { memo, useCallback, useMemo, type ReactNode } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { UnreadDot } from "../threads/task-row.js";
import { Avatar, ChannelGlyph, FaceStack, MentionCount, PeopleOnlyBadge } from "./team-marks.js";
import type { ChannelRowView, DmRowView, TeamDrawerSectionView } from "./team-models.js";

type PageRow =
  | { readonly kind: "knowledge" }
  | { readonly kind: "channels" }
  | { readonly kind: "browse" }
  | { readonly kind: "dms" }
  | { readonly kind: "message-someone" }
  | { readonly kind: "channel"; readonly channel: ChannelRowView }
  | { readonly kind: "dm"; readonly dm: DmRowView };

/**
 * A team's side of the sidebar: its knowledge, its channels (alphabetical), then
 * its direct messages (newest first). Unread is bold; mentions of the reader are
 * an ember count; a DM never shows an unread total. Each heading's + makes one;
 * Browse channels closes the channel list.
 */
export function TeamPageList(props: {
  readonly section: TeamDrawerSectionView;
  /** The team lets the reader make channels. */
  readonly canCreateChannel: boolean;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onKnowledge: () => void;
  readonly onBrowseChannels: () => void;
  readonly onNewChannel: () => void;
  readonly onNewMessage: () => void;
  /** The end of the list is near: the team's next page of channels and DMs. */
  readonly onLoadMore: () => void;
  /** The channel or DM in front, marked as the one open. */
  readonly openChannelId: string | null;
  readonly paddingBottom: number;
}): ReactNode {
  const { section } = props;
  const rows = useMemo(
    (): readonly PageRow[] => [
      { kind: "knowledge" },
      { kind: "channels" },
      ...section.channels.map((channel) => ({ kind: "channel" as const, channel })),
      { kind: "browse" },
      { kind: "dms" },
      ...(section.dms.length === 0
        ? [{ kind: "message-someone" as const }]
        : section.dms.map((dm) => ({ kind: "dm" as const, dm }))),
    ],
    [section.channels, section.dms],
  );
  const {
    onOpenChannel,
    onKnowledge,
    onBrowseChannels,
    onNewChannel,
    onNewMessage,
    canCreateChannel,
    openChannelId,
  } = props;
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<PageRow>) => {
      switch (item.kind) {
        case "knowledge":
          return <QuietRow icon="lightbulb" label="Knowledge" onPress={onKnowledge} strong />;
        case "channels":
          return (
            <Subhead label="Channels">
              <Pressable
                accessibilityLabel={canCreateChannel ? "New channel" : "Browse channels"}
                accessibilityRole="button"
                hitSlop={6}
                onPress={canCreateChannel ? onNewChannel : onBrowseChannels}
                style={({ pressed }) => [styles.headAction, pressed && styles.pressed]}
              >
                <Symbol name="plus" size={15} tint={color.muted} weight="semibold" />
              </Pressable>
            </Subhead>
          );
        case "browse":
          return (
            <QuietRow icon="magnifyingglass" label="Browse channels" onPress={onBrowseChannels} />
          );
        case "message-someone":
          return <QuietRow icon="plus" label="Message someone" onPress={onNewMessage} />;
        case "dms":
          return (
            <Subhead label="Direct messages">
              <Pressable
                accessibilityLabel="New message"
                accessibilityRole="button"
                hitSlop={6}
                onPress={onNewMessage}
                style={({ pressed }) => [styles.headAction, pressed && styles.pressed]}
              >
                <Symbol name="square.and.pencil" size={15} tint={color.muted} weight="semibold" />
              </Pressable>
            </Subhead>
          );
        case "channel":
          return (
            <ChannelRow
              channel={item.channel}
              current={item.channel.id === openChannelId}
              id={item.channel.id}
              onOpen={onOpenChannel}
            />
          );
        case "dm":
          return (
            <DmRow current={item.dm.id === openChannelId} dm={item.dm} onOpen={onOpenChannel} />
          );
      }
    },
    [
      canCreateChannel,
      onBrowseChannels,
      onKnowledge,
      onNewChannel,
      onNewMessage,
      onOpenChannel,
      openChannelId,
    ],
  );
  return (
    <FlatList
      contentContainerStyle={[styles.content, { paddingBottom: props.paddingBottom }]}
      data={rows}
      initialNumToRender={24}
      keyExtractor={rowKey}
      onEndReached={props.onLoadMore}
      onEndReachedThreshold={0.8}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      windowSize={11}
    />
  );
}

function rowKey(row: PageRow): string {
  switch (row.kind) {
    case "channel":
      return `c:${row.channel.id}`;
    case "dm":
      return `d:${row.dm.id}`;
    default:
      return row.kind;
  }
}

/** A way in under a list, quieter than the rows it sits under. */
const QuietRow = memo(function QuietRow(props: {
  readonly icon: "magnifyingglass" | "plus" | "lightbulb";
  readonly label: string;
  readonly onPress: () => void;
  /** A place in the team rather than a way to find or make one. */
  readonly strong?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.mark}>
        <Symbol
          name={props.icon}
          size={15}
          tint={props.strong ? color.textSoft : color.muted}
          weight="medium"
        />
      </View>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        style={[styles.label, !props.strong && styles.muted]}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
});

function Subhead(props: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <View style={styles.head}>
      <AppText role="caption" style={styles.subhead} tone="muted">
        {props.label}
      </AppText>
      {props.children}
    </View>
  );
}

const ChannelRow = memo(function ChannelRow(props: {
  readonly channel: ChannelRowView;
  readonly current: boolean;
  readonly id: string;
  readonly onOpen: (channelId: string) => void;
}): ReactNode {
  const { channel } = props;
  const label = [
    channel.kind === "private" ? `${channel.name}, private` : channel.name,
    channel.peopleOnly ? "people only" : null,
    channel.shared ? "shared channel" : null,
    channel.mentions > 0 ? `${channel.mentions} mentions` : channel.unread ? "unread" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.current }}
      onPress={() => props.onOpen(props.id)}
      style={({ pressed }) => [
        styles.row,
        props.current && styles.current,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.mark}>
        <ChannelGlyph kind={channel.kind} tint={channel.unread ? color.textSoft : color.muted} />
      </View>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        style={[styles.label, rowTone(channel.unread, channel.muted)]}
      >
        {channel.name}
      </AppText>
      {channel.shared ? <Symbol name="link" size={12} tint={color.muted} /> : null}
      {channel.peopleOnly ? <PeopleOnlyBadge compact /> : null}
      <MentionCount count={channel.mentions} />
    </Pressable>
  );
});

const DmRow = memo(function DmRow(props: {
  readonly current: boolean;
  readonly dm: DmRowView;
  readonly onOpen: (channelId: string) => void;
}): ReactNode {
  const { dm } = props;
  const one = dm.people.length === 1 ? dm.people[0]! : null;
  return (
    <Pressable
      accessibilityLabel={`${dm.label}${dm.mentions > 0 ? `, ${dm.mentions} mentions` : dm.unread ? ", unread" : ""}`}
      accessibilityRole="button"
      accessibilityState={{ selected: props.current }}
      onPress={() => props.onOpen(dm.id)}
      style={({ pressed }) => [
        styles.row,
        props.current && styles.current,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.mark}>
        {one === null ? (
          <FaceStack
            faces={dm.people.slice(0, 2).map((person) => ({ kind: "person" as const, person }))}
            ground={color.surfaceElevated}
            size={18}
          />
        ) : (
          <Avatar ground={color.surfaceElevated} person={one} presence size={24} />
        )}
      </View>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        style={[styles.label, rowTone(dm.unread, false)]}
      >
        {dm.label}
      </AppText>
      {dm.mentions > 0 ? <MentionCount count={dm.mentions} /> : dm.unread ? <UnreadDot /> : null}
    </Pressable>
  );
});

function rowTone(unread: boolean, muted: boolean) {
  if (muted) return styles.muted;
  return unread ? styles.unread : styles.read;
}

/** The mark column shared with the drawer's task and place rows. */
const markWidth = 28;

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[8] },
  current: { ...material.selected },
  head: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  headAction: {
    alignItems: "center",
    borderRadius: radius.full,
    height: 32,
    justifyContent: "center",
    marginTop: space[4],
    width: touchTarget,
  },
  label: { flex: 1 },
  mark: { alignItems: "center", width: markWidth },
  muted: { color: color.mutedDim },
  pressed: { ...material.quiet },
  read: { color: color.textSoft },
  row: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: space[10],
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
    paddingHorizontal: space[10] - 1,
    paddingRight: space[12],
  },
  subhead: { paddingBottom: space[2], paddingLeft: space[10], paddingTop: space[10] },
  unread: { color: color.text, fontWeight: "600" },
});
