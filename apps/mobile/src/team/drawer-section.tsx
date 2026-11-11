import { memo, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { UnreadDot } from "../threads/task-row.js";
import {
  Avatar,
  ChannelGlyph,
  FaceStack,
  MentionCount,
  PeopleOnlyBadge,
  TeamTile,
} from "./team-marks.js";
import type { ChannelRowView, DmRowView, TeamDrawerSectionView } from "./team-models.js";

export interface TeamDrawerActions {
  readonly onFold: (teamId: string, folded: boolean) => void;
  /** The team's + menu: New channel, New message, Browse channels, Invite people. */
  readonly onTeamMenu: (teamId: string) => void;
  readonly onOpenChannel: (teamId: string, channelId: string) => void;
  readonly onMoreDms: (teamId: string) => void;
  /** A team the reader left or was removed from: take its row out of the drawer. */
  readonly onRemoveTeam: (teamId: string) => void;
}

/**
 * One team in the drawer: its header, its channels (alphabetical), then its
 * direct messages (newest first). Unread is bold; mentions of the reader are
 * an ember count; a DM never shows an unread total. A folded team keeps its
 * mention total on its header, so nothing for the reader hides.
 */
export const TeamDrawerSection = memo(function TeamDrawerSection(props: {
  readonly actions: TeamDrawerActions;
  /** The channel or DM on screen. */
  readonly currentId: string | null;
  readonly section: TeamDrawerSectionView;
}): ReactNode {
  const { actions, section } = props;
  const teamId = section.team.id;
  if (section.state === "removed") {
    return (
      <View style={styles.removed}>
        <TeamTile size={20} team={section.team} />
        <View style={styles.removedWords}>
          <AppText numberOfLines={1} role="secondaryMedium" tone="soft">
            You're no longer in {section.team.name}
          </AppText>
          <AppText role="caption" tone="muted">
            Tasks it started stay in your list
          </AppText>
        </View>
        <Pressable
          accessibilityLabel={`Remove ${section.team.name} from the sidebar`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => actions.onRemoveTeam(teamId)}
          style={styles.iconButton}
        >
          <Symbol name="xmark" size={14} tint={color.muted} weight="semibold" />
        </Pressable>
      </View>
    );
  }
  const dim = section.state !== "live";
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Pressable
          accessibilityHint={section.folded ? "Shows its channels" : "Hides its channels"}
          accessibilityLabel={headLabel(section)}
          accessibilityRole="button"
          accessibilityState={{ expanded: !section.folded }}
          onPress={() => actions.onFold(teamId, !section.folded)}
          style={({ pressed }) => [styles.headMain, pressed && styles.pressed]}
        >
          <View style={styles.mark}>
            <TeamTile size={20} team={section.team} />
          </View>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
            style={styles.teamName}
          >
            {section.team.name}
          </AppText>
          <StateTag state={section.state} />
          {section.folded ? (
            <>
              {section.mentionTotal > 0 ? (
                <MentionCount count={section.mentionTotal} />
              ) : section.unread ? (
                <UnreadDot />
              ) : null}
              <Symbol name="chevron.right" size={12} tint={color.muted} weight="semibold" />
            </>
          ) : null}
        </Pressable>
        {section.folded ? null : (
          <Pressable
            accessibilityLabel={`New in ${section.team.name}`}
            accessibilityRole="button"
            onPress={() => actions.onTeamMenu(teamId)}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Symbol name="plus" size={16} tint={color.muted} weight="medium" />
          </Pressable>
        )}
      </View>
      {section.folded ? null : (
        <View style={dim && styles.dim}>
          {section.channels.map((channel) => (
            <ChannelRow
              channel={channel}
              current={props.currentId === channel.id}
              key={channel.id}
              onOpen={() => actions.onOpenChannel(teamId, channel.id)}
            />
          ))}
          {section.dms.length === 0 ? null : (
            <AppText role="caption" style={styles.subhead} tone="muted">
              Direct messages
            </AppText>
          )}
          {section.dms.map((dm) => (
            <DmRow
              current={props.currentId === dm.id}
              dm={dm}
              key={dm.id}
              onOpen={() => actions.onOpenChannel(teamId, dm.id)}
            />
          ))}
          {section.moreDms > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => actions.onMoreDms(teamId)}
              style={({ pressed }) => [styles.more, pressed && styles.pressed]}
            >
              <AppText role="caption" tone="muted">
                {section.moreDms} more
              </AppText>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
});

function headLabel(section: TeamDrawerSectionView): string {
  const parts = [section.team.name];
  if (section.mentionTotal > 0) parts.push(`${section.mentionTotal} mentions`);
  else if (section.unread) parts.push("unread");
  if (section.state === "offline") parts.push("can't be reached");
  if (section.state === "update-app") parts.push("update Opensteer to use it");
  if (section.state === "update-server") parts.push("its server needs an update");
  return parts.join(", ");
}

function StateTag(props: { readonly state: TeamDrawerSectionView["state"] }): ReactNode {
  if (props.state === "live" || props.state === "removed") return null;
  const update = props.state === "update-app";
  return (
    <View style={[styles.tag, update && styles.tagUpdate]}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={update ? styles.tagUpdateText : styles.tagText}
      >
        {props.state === "offline" ? "Offline" : "Update"}
      </AppText>
    </View>
  );
}

const ChannelRow = memo(function ChannelRow(props: {
  readonly channel: ChannelRowView;
  readonly current: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const { channel } = props;
  const label = [
    channel.kind === "private" ? `${channel.name}, private` : channel.name,
    channel.peopleOnly ? "people only" : null,
    channel.mentions > 0 ? `${channel.mentions} mentions` : channel.unread ? "unread" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.current }}
      onPress={props.onOpen}
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
      {channel.peopleOnly ? <PeopleOnlyBadge compact /> : null}
      <MentionCount count={channel.mentions} />
    </Pressable>
  );
});

const DmRow = memo(function DmRow(props: {
  readonly current: boolean;
  readonly dm: DmRowView;
  readonly onOpen: () => void;
}): ReactNode {
  const { dm } = props;
  const one = dm.people.length === 1 ? dm.people[0]! : null;
  return (
    <Pressable
      accessibilityLabel={`${dm.label}${dm.mentions > 0 ? `, ${dm.mentions} mentions` : dm.unread ? ", unread" : ""}`}
      accessibilityRole="button"
      accessibilityState={{ selected: props.current }}
      onPress={props.onOpen}
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
  current: { ...material.selected },
  dim: { opacity: 0.55 },
  head: { alignItems: "center", flexDirection: "row", marginTop: space[12] },
  headMain: {
    alignItems: "center",
    borderRadius: radius.md,
    flex: 1,
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingHorizontal: space[10],
  },
  iconButton: {
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  label: { flex: 1 },
  mark: { alignItems: "center", width: markWidth },
  more: {
    justifyContent: "center",
    minHeight: touchTarget - 8,
    paddingLeft: space[10] + markWidth + space[10],
  },
  muted: { color: color.mutedDim },
  pressed: { ...material.quiet },
  read: { color: color.textSoft },
  removed: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[10],
    marginTop: space[12],
    paddingLeft: space[10],
    paddingVertical: space[8],
  },
  removedWords: { flex: 1, minWidth: 0 },
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
  section: { gap: 0 },
  subhead: { paddingBottom: space[2], paddingLeft: space[10], paddingTop: space[10] },
  tag: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    paddingHorizontal: space[6],
    paddingVertical: 1,
  },
  tagText: { color: color.muted, fontWeight: "600" },
  tagUpdate: { backgroundColor: color.amberWash },
  tagUpdateText: { color: color.amber, fontWeight: "600" },
  teamName: { color: color.text, flexShrink: 1, fontWeight: "600" },
  unread: { color: color.text, fontWeight: "600" },
});
