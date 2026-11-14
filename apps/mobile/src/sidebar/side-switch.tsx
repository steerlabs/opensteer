import type { TeamSessionClient } from "@opensteer/client/team";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { MobileTeam } from "../team/mobile-teams.js";
import { TeamTile } from "../team/team-marks.js";
import { color, controlFontScaleLimit, material, mix, radius, space, type } from "../theme.js";
import { NativeMenu, type NativeMenuSection } from "../thread/composer-menu.js";
import { duration, move } from "../ui/motion.js";
import { Symbol } from "../ui/symbol.js";
import { markSegmentWidth, segmentGap, switchLayout, trackPadding } from "./side-switch-layout.js";
import type { SidebarSide } from "./sidebar-side.js";

/**
 * Tasks and each of the person's teams, as one segmented control at the head
 * of the sidebar: the same switch the desktop sidebar has.
 *
 * Each segment carries what is waiting on that side, so a mention in another
 * team shows without leaving this one: an amber count for questions on Tasks,
 * an ember count for mentions in a team. The chosen team's segment opens its
 * menu. Teams past what the track holds fold into a last segment that lists
 * them; nothing scrolls sideways, so the drawer's own swipe stays the drawer's.
 *
 * Only the person changes the side. The chosen plate slides under the segment
 * as the segments settle into their new widths, on the UI thread.
 */
export const SideSwitch = memo(function SideSwitch(props: {
  readonly active: SidebarSide;
  /** The sidebar's colour behind the switch. */
  readonly ground: string;
  readonly needsYou: number;
  readonly onSelect: (side: SidebarSide) => void;
  /** The chosen team's own menu. */
  readonly teamMenu: readonly NativeMenuSection[];
  readonly teams: readonly MobileTeam[];
}): ReactNode {
  const { active, onSelect, teams } = props;
  // Opaque, so a count on a mark's corner can be cut out of it exactly.
  const ground = mix(props.ground, "#ffffff", 0.05);
  const [width, setWidth] = useState(0);
  const sides = useMemo(
    (): readonly SidebarSide[] => ["tasks", ...teams.map((team) => team.teamId)],
    [teams],
  );
  const layout = switchLayout(sides, active, width);
  const thumb = useThumb(active);
  const byId = useMemo(() => new Map(teams.map((team) => [team.teamId, team])), [teams]);
  const foldedKey = layout.folded.join(" ");
  const folded = useMemo(
    () => (foldedKey === "" ? [] : foldedKey.split(" ").flatMap((side) => byId.get(side) ?? [])),
    [byId, foldedKey],
  );

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidth((current) => (current === next ? current : next));
      }}
      style={[styles.track, { backgroundColor: ground }]}
    >
      <Animated.View pointerEvents="none" style={[styles.thumb, thumb.style]} />
      {layout.shown.map((side) => {
        const team = side === "tasks" ? null : byId.get(side);
        if (team === undefined) return null;
        const chosen = side === active;
        return (
          <Animated.View
            key={side}
            layout={move}
            onLayout={(event: LayoutChangeEvent) => thumb.measure(side, event)}
            style={chosen || layout.named ? styles.grow : styles.markOnly}
          >
            {team === null ? (
              <Segment
                accessibilityLabel={
                  props.needsYou === 0 ? "Tasks" : `Tasks, ${needYouPhrase(props.needsYou)}`
                }
                chosen={chosen}
                count={props.needsYou}
                ground={ground}
                label="Tasks"
                mark={
                  <Symbol
                    name="checklist"
                    size={16}
                    tint={chosen ? color.text : color.muted}
                    weight={chosen ? "semibold" : "medium"}
                  />
                }
                menu={null}
                named={layout.named}
                onPress={() => onSelect("tasks")}
                tone="amber"
              />
            ) : (
              <TeamSegment
                chosen={chosen}
                ground={ground}
                menu={chosen ? props.teamMenu : null}
                named={layout.named}
                onSelect={onSelect}
                team={team}
              />
            )}
          </Animated.View>
        );
      })}
      {folded.length === 0 ? null : (
        <Animated.View key="folded" layout={move} style={styles.markOnly}>
          <FoldedSegment ground={ground} onSelect={onSelect} teams={folded} />
        </Animated.View>
      )}
    </View>
  );
});

/**
 * The chosen plate. It is placed where the chosen segment is measured, without
 * moving the first time, and slides on every later change of side or width.
 */
function useThumb(active: SidebarSide) {
  const frames = useRef(new Map<SidebarSide, { x: number; width: number }>());
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const placed = useRef(false);
  const place = useCallback(
    (frame: { x: number; width: number } | undefined) => {
      if (frame === undefined) return;
      if (!placed.current) {
        placed.current = true;
        x.value = frame.x;
        width.value = frame.width;
        return;
      }
      x.value = withTiming(frame.x, { duration: duration.enter });
      width.value = withTiming(frame.width, { duration: duration.enter });
    },
    [width, x],
  );
  useEffect(() => place(frames.current.get(active)), [active, place]);
  const measure = useCallback(
    (side: SidebarSide, event: LayoutChangeEvent) => {
      const { x: left, width: span } = event.nativeEvent.layout;
      const frame = { x: left, width: span };
      frames.current.set(side, frame);
      if (side === active) place(frame);
    },
    [active, place],
  );
  const style = useAnimatedStyle(() => ({
    opacity: width.value === 0 ? 0 : 1,
    transform: [{ translateX: x.value }],
    width: width.value,
  }));
  return { measure, style };
}

const TeamSegment = memo(function TeamSegment(props: {
  readonly chosen: boolean;
  readonly ground: string;
  readonly menu: readonly NativeMenuSection[] | null;
  readonly named: boolean;
  readonly onSelect: (side: SidebarSide) => void;
  readonly team: MobileTeam;
}): ReactNode {
  const { chosen, team, onSelect } = props;
  const mentions = useTeamMentions(team.session);
  const status = teamStatus(team);
  const select = useCallback(() => onSelect(team.teamId), [onSelect, team.teamId]);
  return (
    <Segment
      accessibilityHint={chosen ? `Opens ${team.name}'s menu` : undefined}
      accessibilityLabel={[team.name, mentionPhrase(mentions), status].filter(Boolean).join(", ")}
      chosen={chosen}
      count={mentions}
      dim={status !== null}
      ground={props.ground}
      label={team.name}
      mark={<TeamTile size={20} team={{ id: team.teamId, name: team.name, imageUri: null }} />}
      menu={props.menu}
      named={props.named}
      onPress={select}
      tone="ember"
    />
  );
});

/** The teams past what the track holds, as a menu that chooses one. */
function FoldedSegment(props: {
  readonly ground: string;
  readonly onSelect: (side: SidebarSide) => void;
  readonly teams: readonly MobileTeam[];
}): ReactNode {
  const counts = useMentionCounts(props.teams);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const label = `${props.teams.length} more ${props.teams.length === 1 ? "team" : "teams"}`;
  return (
    <NativeMenu
      accessibilityLabel={total === 0 ? label : `${label}, ${mentionPhrase(total)}`}
      options={props.teams.map((team, index) => ({
        id: team.teamId,
        label: counts[index]! > 0 ? `${team.name}  ${countText(counts[index]!)}` : team.name,
        onPress: () => props.onSelect(team.teamId),
      }))}
      style={styles.fill}
      triggerStyle={styles.face}
    >
      <View style={styles.mark}>
        <Symbol name="ellipsis" size={16} tint={color.muted} weight="semibold" />
        {total === 0 ? null : <Count corner count={total} ground={props.ground} tone="ember" />}
      </View>
    </NativeMenu>
  );
}

/**
 * One side's segment: its mark, and its name and count when it is chosen or
 * every segment is named; otherwise its count sits on the mark's corner.
 */
function Segment(props: {
  readonly accessibilityHint?: string | undefined;
  readonly accessibilityLabel: string;
  readonly chosen: boolean;
  readonly count: number;
  /** The side cannot show anything new now: its team is offline or signed out. */
  readonly dim?: boolean;
  readonly ground: string;
  readonly label: string;
  readonly mark: ReactNode;
  readonly menu: readonly NativeMenuSection[] | null;
  readonly named: boolean;
  readonly onPress: () => void;
  readonly tone: "amber" | "ember";
}): ReactNode {
  const { chosen, count } = props;
  const spelled = chosen || props.named;
  const face = (
    <>
      <View style={[styles.mark, props.dim === true && styles.dim]}>
        {props.mark}
        {spelled || count === 0 ? null : (
          <Count corner count={count} ground={props.ground} tone={props.tone} />
        )}
      </View>
      {spelled ? (
        <Text
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          style={[type.caption, styles.label, chosen && styles.chosenLabel]}
        >
          {props.label}
        </Text>
      ) : null}
      {spelled && count > 0 ? (
        <Count count={count} ground={props.ground} tone={props.tone} />
      ) : null}
      {props.menu === null ? null : (
        <Symbol name="chevron.down" size={10} tint={color.muted} weight="bold" />
      )}
    </>
  );
  if (props.menu !== null)
    return (
      <NativeMenu
        {...(props.accessibilityHint === undefined
          ? {}
          : { accessibilityHint: props.accessibilityHint })}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="tab"
        accessibilityState={{ selected: chosen }}
        options={props.menu}
        style={styles.fill}
        triggerStyle={[styles.face, styles.spelled]}
      >
        {face}
      </NativeMenu>
    );
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="tab"
      accessibilityState={{ selected: chosen }}
      hitSlop={{ bottom: 6, top: 6 }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.face,
        spelled && styles.spelled,
        pressed && !chosen && styles.pressed,
      ]}
    >
      {face}
    </Pressable>
  );
}

function Count(props: {
  readonly corner?: boolean;
  readonly count: number;
  readonly ground: string;
  readonly tone: "amber" | "ember";
}): ReactNode {
  return (
    <View
      style={[
        styles.count,
        props.tone === "amber" ? styles.amber : styles.ember,
        props.corner === true && [styles.corner, { borderColor: props.ground }],
      ]}
    >
      <Text
        allowFontScaling={false}
        style={[styles.countText, props.tone === "amber" ? styles.onAmber : styles.onEmber]}
      >
        {countText(props.count)}
      </Text>
    </View>
  );
}

/** Mentions of the reader across a team, read from that team's own session only. */
export function useTeamMentions(session: TeamSessionClient | null): number {
  const read = useCallback(() => session?.getSnapshot().sidebar?.totalMentionCount ?? 0, [session]);
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Each folded team's mentions, held until one of them changes. */
function useMentionCounts(teams: readonly MobileTeam[]): readonly number[] {
  const cached = useRef<readonly number[]>([]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = teams.map((team) => team.session?.subscribe(listener) ?? (() => undefined));
      return () => stops.forEach((stop) => stop());
    },
    [teams],
  );
  const read = useCallback(() => {
    const next = teams.map((team) => team.session?.getSnapshot().sidebar?.totalMentionCount ?? 0);
    const held = cached.current;
    if (next.length !== held.length || next.some((count, index) => count !== held[index]))
      cached.current = next;
    return cached.current;
  }, [teams]);
  return useSyncExternalStore(subscribe, read, read);
}

/** What a team can't do now, in a word, or null while it can be read. */
export function teamStatus(team: MobileTeam): string | null {
  switch (team.state) {
    case "live":
    case "loading":
      return null;
    case "offline":
      return "Offline";
    case "signed-out":
      return "Signed out";
    case "update-app":
    case "update-server":
      return "Needs an update";
    case "removed":
    case "join":
      return "No longer a member";
  }
}

function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function mentionPhrase(count: number): string | null {
  return count === 0 ? null : count === 1 ? "1 mention" : `${count} mentions`;
}

function needYouPhrase(count: number): string {
  return count === 1 ? "1 needs you" : `${count} need you`;
}

const segmentHeight = 34;

const styles = StyleSheet.create({
  amber: { backgroundColor: color.amber },
  chosenLabel: { color: color.text },
  count: {
    alignItems: "center",
    borderRadius: radius.full,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 5,
  },
  countText: { fontSize: 11, fontVariant: ["tabular-nums"], fontWeight: "700", lineHeight: 13 },
  // On the mark's corner, cut out of the ground behind the switch.
  corner: {
    borderWidth: 2,
    height: 18,
    minWidth: 18,
    paddingHorizontal: 4,
    position: "absolute",
    right: -9,
    top: -7,
  },
  dim: { opacity: 0.45 },
  ember: { backgroundColor: color.ember },
  face: {
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    height: segmentHeight,
    justifyContent: "center",
  },
  fill: { flex: 1 },
  grow: { flexBasis: 0, flexGrow: 1, minWidth: 0 },
  label: { color: color.textSoft, flexShrink: 1, fontWeight: "600" },
  mark: { alignItems: "center", height: 20, justifyContent: "center", minWidth: 20 },
  markOnly: { width: markSegmentWidth },
  onAmber: { color: color.inkOnAmber },
  onEmber: { color: color.inkOnEmber },
  pressed: { ...material.quiet },
  spelled: { paddingHorizontal: space[10] },
  thumb: {
    ...material.selected,
    borderRadius: radius.full,
    height: segmentHeight,
    left: 0,
    position: "absolute",
    top: trackPadding,
  },
  track: {
    borderColor: color.line,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: segmentGap,
    marginBottom: space[8],
    marginHorizontal: space[12],
    padding: trackPadding,
  },
});
