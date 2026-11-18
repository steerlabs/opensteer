import {
  moreTeamsKey,
  sideSwitchLayout,
  type SideSwitchMetrics,
  type TeamSessionClient,
} from "@opensteer/client/team";
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
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { MobileTeam } from "../team/mobile-teams.js";
import { TeamTile } from "../team/team-marks.js";
import {
  color,
  controlFontScaleLimit,
  material,
  mix,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { duration, move } from "../ui/motion.js";
import { Symbol } from "../ui/symbol.js";
import type { SidebarSide } from "./sidebar-side.js";

/** A segment drawn as its mark alone, at a full touch target. */
const markSegmentWidth = 44;
const segmentGap = 2;
const trackPadding = 3;

/** The phone's measures for the shared layout: marks at a full touch target. */
const metrics: SideSwitchMetrics = {
  padding: trackPadding,
  gap: segmentGap,
  mark: markSegmentWidth,
  named: markSegmentWidth + 64,
};

/**
 * Tasks and each of the person's teams, as one segmented control at the head
 * of the sidebar: the same switch, laid out by the same rule, as the desktop
 * sidebar's. Tasks keeps its own width, the team last shown takes the rest and
 * says its name, and every other team is its mark, so any team is one visible
 * tap away. Teams past what the track holds fold into a last segment that lists
 * them; nothing scrolls sideways, so the drawer's own swipe stays the drawer's.
 *
 * Each segment carries what is waiting on that side: an amber count for
 * questions on Tasks, an ember count for mentions in a team. Only the person
 * changes the side. The chosen plate slides under the segment as the segments
 * settle into their new widths, on the UI thread.
 */
export const SideSwitch = memo(function SideSwitch(props: {
  readonly active: SidebarSide;
  /** The sidebar's colour behind the switch. */
  readonly ground: string;
  readonly needsYou: number;
  readonly onSelect: (side: SidebarSide) => void;
  /** The team that owns the named segment, from `recentTeam`. */
  readonly recent: string;
  readonly teams: readonly MobileTeam[];
}): ReactNode {
  const { active, onSelect, recent, teams } = props;
  // Opaque, so a count on a mark's corner can be cut out of it exactly.
  const ground = mix(props.ground, "#ffffff", 0.05);
  const [width, setWidth] = useState(0);
  const [tasksWidth, setTasksWidth] = useState(0);
  const teamIds = useMemo(() => teams.map((team) => team.teamId), [teams]);
  const layout = sideSwitchLayout(
    // Unmeasured until Tasks is, so nothing folds or loses its name on a guess.
    { teamIds, recent, width: tasksWidth === 0 ? 0 : width, tasks: tasksWidth },
    metrics,
  );
  // A team folded away is shown chosen on the folded segment.
  const thumb = useThumb(
    layout.segments.some((segment) => segment.key === active) ? active : moreTeamsKey,
  );
  const byId = useMemo(() => new Map(teams.map((team) => [team.teamId, team])), [teams]);
  const foldedKey = layout.folded.join(" ");
  const folded = useMemo(
    () => (foldedKey === "" ? [] : foldedKey.split(" ").flatMap((side) => byId.get(side) ?? [])),
    [byId, foldedKey],
  );
  const titled = !layout.named && active !== "tasks" ? byId.get(active) : undefined;

  return (
    <>
      <View
        accessibilityRole="tablist"
        onLayout={(event: LayoutChangeEvent) => {
          const next = Math.round(event.nativeEvent.layout.width);
          setWidth((current) => (current === next ? current : next));
        }}
        style={[styles.track, { backgroundColor: ground }]}
      >
        <Animated.View pointerEvents="none" style={[styles.thumb, thumb.style]} />
        {layout.segments.map(({ key }) => {
          if (key === moreTeamsKey)
            return (
              <Animated.View
                key={key}
                layout={move}
                onLayout={(event: LayoutChangeEvent) => thumb.measure(key, event)}
                style={styles.markOnly}
              >
                <FoldedSegment ground={ground} onSelect={onSelect} teams={folded} />
              </Animated.View>
            );
          const team = key === "tasks" ? null : byId.get(key);
          if (team === undefined) return null;
          const chosen = key === active;
          return (
            <Animated.View
              key={key}
              layout={move}
              onLayout={(event: LayoutChangeEvent) => {
                thumb.measure(key, event);
                if (key === "tasks") {
                  const next = Math.round(event.nativeEvent.layout.width);
                  setTasksWidth((current) => (current === next ? current : next));
                }
              }}
              style={
                key === "tasks" ? styles.natural : key === recent ? styles.grow : styles.markOnly
              }
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
                  named
                  onPress={() => onSelect("tasks")}
                  tone="amber"
                />
              ) : (
                <TeamSegment
                  chosen={chosen}
                  ground={ground}
                  named={key === recent && layout.named}
                  onSelect={onSelect}
                  team={team}
                />
              )}
            </Animated.View>
          );
        })}
      </View>
      {titled === undefined ? null : (
        <View style={styles.title}>
          <TeamTile size={20} team={{ id: titled.teamId, name: titled.name, imageUri: null }} />
          <FadingName
            accessibilityRole="header"
            ground={props.ground}
            label={titled.name}
            style={[type.bodyMedium, styles.titleText]}
          />
        </View>
      )}
    </>
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
      accessibilityLabel={[team.name, mentionPhrase(mentions), status].filter(Boolean).join(", ")}
      chosen={chosen}
      count={mentions}
      dim={status !== null}
      ground={props.ground}
      label={team.name}
      mark={<TeamTile size={20} team={{ id: team.teamId, name: team.name, imageUri: null }} />}
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
      triggerStyle={[styles.face, styles.menuFace]}
    >
      <View style={styles.mark}>
        <Symbol name="ellipsis" size={16} tint={color.muted} weight="semibold" />
        {total === 0 ? null : <Count corner count={total} ground={props.ground} tone="ember" />}
      </View>
    </NativeMenu>
  );
}

/**
 * One side's segment: its mark, and its name and count when it is named;
 * otherwise its count sits on the mark's corner.
 */
function Segment(props: {
  readonly accessibilityLabel: string;
  readonly chosen: boolean;
  readonly count: number;
  /** The side cannot show anything new now: its team is offline or signed out. */
  readonly dim?: boolean;
  readonly ground: string;
  readonly label: string;
  readonly mark: ReactNode;
  readonly named: boolean;
  readonly onPress: () => void;
  readonly tone: "amber" | "ember";
}): ReactNode {
  const { chosen, count, named } = props;
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="tab"
      accessibilityState={{ selected: chosen }}
      hitSlop={{ bottom: 6, top: 6 }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.face,
        named && styles.spelled,
        pressed && !chosen && styles.pressed,
      ]}
    >
      <View style={[styles.mark, props.dim === true && styles.dim]}>
        {props.mark}
        {named || count === 0 ? null : (
          <Count corner count={count} ground={props.ground} tone={props.tone} />
        )}
      </View>
      {named ? (
        <FadingName
          // The name sits on the plate when chosen, on the track otherwise.
          ground={chosen ? String(material.selected.backgroundColor) : props.ground}
          label={props.label}
          style={[type.caption, styles.label, chosen && styles.chosenLabel]}
        />
      ) : null}
      {named && count > 0 ? <Count count={count} ground={props.ground} tone={props.tone} /> : null}
    </Pressable>
  );
}

/**
 * A name on one line that runs to its edge and fades there, as on the desktop,
 * rather than ending in an ellipsis. The fade shows only while the name is cut.
 */
function FadingName(props: {
  readonly accessibilityRole?: "header";
  /** The opaque colour behind the name, which the fade blends into. */
  readonly ground: string;
  readonly label: string;
  readonly style: StyleProp<TextStyle>;
}): ReactNode {
  const [room, setRoom] = useState(0);
  const [natural, setNatural] = useState(0);
  return (
    <View
      onLayout={(event: LayoutChangeEvent) => setRoom(event.nativeEvent.layout.width)}
      style={styles.name}
    >
      <Text
        accessibilityRole={props.accessibilityRole}
        ellipsizeMode="clip"
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        style={props.style}
      >
        {props.label}
      </Text>
      {/* The name's own width, laid out where nothing constrains it. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.measure}
      >
        <Text
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          onLayout={(event: LayoutChangeEvent) => setNatural(event.nativeEvent.layout.width)}
          style={props.style}
        >
          {props.label}
        </Text>
      </View>
      {natural > room + 0.5 ? (
        <View
          pointerEvents="none"
          style={[
            styles.fade,
            { backgroundImage: `linear-gradient(to right, ${props.ground}00, ${props.ground})` },
          ]}
        />
      ) : null}
    </View>
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
      // One unanswered call says the team is out of reach, not that this phone is offline.
      return "Can't reach";
    case "failed":
      return "Couldn't open";
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
  fade: { bottom: 0, end: 0, position: "absolute", top: 0, width: space[16] },
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
  grow: { flexBasis: 0, flexGrow: 1, minWidth: markSegmentWidth },
  label: { color: color.textSoft, flexShrink: 1, fontWeight: "600" },
  mark: { alignItems: "center", height: 20, justifyContent: "center", minWidth: 20 },
  markOnly: { width: markSegmentWidth },
  name: { flexShrink: 1, minWidth: 0, overflow: "hidden" },
  measure: {
    alignItems: "flex-start",
    height: 0,
    opacity: 0,
    overflow: "hidden",
    position: "absolute",
    width: 4096,
  },
  natural: { flexShrink: 0 },
  // A menu's trigger takes no hit slop, so it reaches a full touch target past the plate.
  menuFace: {
    height: touchTarget,
    marginVertical: -(touchTarget - segmentHeight) / 2,
  },
  onAmber: { color: color.inkOnAmber },
  onEmber: { color: color.inkOnEmber },
  pressed: { ...material.quiet },
  spelled: { paddingHorizontal: space[10] },
  title: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    marginBottom: space[8],
    marginHorizontal: space[16],
  },
  titleText: { color: color.text, flexShrink: 1 },
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
