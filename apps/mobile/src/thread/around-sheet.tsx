import {
  canRespondToRequests,
  familyGlanceMarks,
  formatMoment,
  sameTaskFamily,
  sameTaskMark,
  schedulesClient,
  taskFamily,
  threadMark,
  type FamilyTask,
  type HostClient,
  type HostSnapshot,
  type TaskFamily,
  type ThreadAutomation,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  FlatList,
  Image,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { surfaceRoute } from "../browser/surface-route.js";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, type } from "../theme.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, Notice, StatusDot, Toggle } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { TaskMarks } from "./around-button.js";
import {
  aroundFrom,
  aroundPlaces,
  aroundSections,
  earlierDays,
  openingSection,
  sameAroundPlaces,
  sameRequesterLink,
  shownSection,
  type AroundPlace,
  type AroundSection,
} from "./around-model.js";
import { TaskStatus } from "./task-status.js";

export type AroundScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
}>;

/**
 * Around this thread: the conversation it works for, then one tile for each
 * of its places, running tasks, earlier tasks and schedules that has anything
 * in it, echoing the header button that opened it. The chosen tile's list
 * fills the rest of the sheet, so no section is ever below another; a tap on
 * a tile or a swipe across the list moves between them.
 *
 * It opens on what needs the reader and stays on the section they choose
 * while it is open, however the Host's data changes under it. A row opens
 * exactly what it names, over the conversation rather than inside this
 * sheet, so Back from it returns there.
 */
export function AroundScreen(props: AroundScreenProps): ReactNode {
  const { deploymentId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Unavailable />;
  }
  return (
    <Around deploymentId={deploymentId} hostClient={selection.hostClient} threadId={threadId} />
  );
}

const selectChangeBlocked = (snapshot: HostSnapshot) => !canRespondToRequests(snapshot);

function Around(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { deploymentId, hostClient, threadId } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const from = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => aroundFrom(snapshot, threadId), [threadId]),
    sameRequesterLink,
  );
  const fromMark = useHostSelector(
    hostClient,
    useCallback(
      (snapshot: HostSnapshot) =>
        from === null || from.threadId === snapshot.homeThreadId
          ? null
          : threadMark(from.threadId, snapshot),
      [from],
    ),
    sameTaskMark,
  );
  const places = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => aroundPlaces(snapshot, threadId), [threadId]),
    sameAroundPlaces,
  );
  const family = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => taskFamily(snapshot, threadId), [threadId]),
    sameTaskFamily,
  );
  const blocked = useHostSelector(hostClient, selectChangeBlocked);
  const sections = useMemo(() => aroundSections(places, family), [places, family]);

  // Chosen once, when there is first anything to choose, then kept: data
  // changing under the sheet never moves it. A section that empties gives way
  // to the first that has anything, and that becomes the choice.
  const [chosen, setChosen] = useState<AroundSection | null>(null);
  const shown = chosen === null ? openingSection(places, family) : shownSection(chosen, sections);
  if (shown !== null && shown !== chosen) setChosen(shown);
  const choose = useCallback((section: AroundSection) => {
    setChosen(section);
    void Haptics.selectionAsync();
  }, []);

  const openPlace = useCallback(
    (place: AroundPlace) => {
      navigation.goBack();
      navigation.dispatch(
        StackActions.push(
          "WorkspaceBrowser",
          surfaceRoute(deploymentId, threadId, place.destination),
        ),
      );
    },
    [deploymentId, navigation, threadId],
  );
  const openSchedule = useCallback(
    (triggerId: string) => {
      navigation.goBack();
      navigation.dispatch(StackActions.push("Schedule", { deploymentId, triggerId }));
    },
    [deploymentId, navigation],
  );
  // Chat is the root under every stack, so it is returned to; a conversation
  // directly under this one is gone back to rather than opened a second time.
  const openThread = useCallback(
    (id: string) => {
      if (id === hostClient.getSnapshot().homeThreadId) {
        navigation.dispatch(StackActions.popTo("Home", { deploymentId }));
        return;
      }
      const under = navigation.getState()?.routes.at(-3);
      if (
        under?.name === "Thread" &&
        isRecord(under.params) &&
        under.params["deploymentId"] === deploymentId &&
        under.params["threadId"] === id
      ) {
        navigation.dispatch(StackActions.pop(2));
        return;
      }
      navigation.goBack();
      navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }));
    },
    [deploymentId, hostClient, navigation],
  );
  const side = useMemo(
    () => ({ paddingLeft: insets.left + sheetInset, paddingRight: insets.right + sheetInset }),
    [insets.left, insets.right],
  );
  const pageInset = useMemo(
    () => ({ ...side, paddingBottom: insets.bottom + space[24] }),
    [insets.bottom, side],
  );
  const rows = useMemo(
    () => ({ blocked, hostClient, openPlace, openSchedule, openThread }),
    [blocked, hostClient, openPlace, openSchedule, openThread],
  );

  return (
    <View style={styles.sheet}>
      <View style={side}>
        <View style={styles.header}>
          <View accessibilityRole="header" style={styles.heading}>
            <AppText role="title">Around this thread</AppText>
          </View>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={space[8]}
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <Symbol name="xmark" size={13} tint={color.textSoft} weight="semibold" />
          </Pressable>
        </View>
        {from === null ? null : (
          <Pressable
            accessibilityLabel={`From ${from.title}`}
            accessibilityHint="Opens the conversation this task works for"
            accessibilityRole="button"
            hitSlop={space[6]}
            onPress={() => openThread(from.threadId)}
            style={({ pressed }) => [styles.from, pressed && styles.pressed]}
          >
            <Symbol name="arrow.up" size={12} tint={color.muted} />
            {fromMark === null ? <ChatOrb size={16} /> : <TaskMark mark={fromMark} size={16} />}
            <AppText numberOfLines={1} role="caption" style={styles.fromWords} tone="soft">
              From {from.title}
            </AppText>
          </Pressable>
        )}
        {sections.length > 1 && shown !== null ? (
          <Tiles
            family={family}
            onChoose={choose}
            places={places}
            sections={sections}
            shown={shown}
          />
        ) : null}
      </View>
      {shown === null ? (
        from === null ? (
          <AppText role="secondary" tone="muted" style={[styles.empty, side]}>
            Nothing is around this conversation now.
          </AppText>
        ) : null
      ) : (
        <Pages
          inset={pageInset}
          family={family}
          onChoose={choose}
          places={places}
          rows={rows}
          sections={sections}
          shown={shown}
        />
      )}
    </View>
  );
}

/** The sheet's side inset; lists and tiles share it so their edges line up. */
const sheetInset = space[12];
const tileGap = space[8];
/** The narrowest tile whose label still fits at the reader's text size. */
const tileMinWidth = 72;

const sectionLabel = {
  earlier: "Earlier",
  places: "Places",
  schedules: "Schedules",
  tasks: "Tasks",
} as const satisfies Record<AroundSection, string>;

/** Needs-you first, otherwise in the order they were handed out. */
function runningInOrder(family: TaskFamily): readonly FamilyTask[] {
  return family.running.some(({ needsYou }) => needsYou)
    ? [...family.running].sort((left, right) => Number(right.needsYou) - Number(left.needsYou))
    : family.running;
}

/**
 * One tab per section that has anything in it, in the header button's order
 * and with its symbols. Four sit in a row; when the reader's text would not
 * fit four across, they wrap two by two rather than cut a label short.
 */
const Tiles = memo(function Tiles(props: {
  readonly family: TaskFamily;
  readonly onChoose: (section: AroundSection) => void;
  readonly places: readonly AroundPlace[];
  readonly sections: readonly AroundSection[];
  readonly shown: AroundSection;
}): ReactNode {
  const { family, places, sections } = props;
  const screen = useWindowDimensions();
  // The window is the sheet's width on a phone, so the first frame is already
  // laid out; a narrower sheet corrects it once measured.
  const [measured, setWidth] = useState<number | null>(null);
  const width = measured ?? screen.width - 2 * sheetInset;
  const across = (count: number) => (width - (count - 1) * tileGap) / count;
  const columns =
    sections.length > 2 && across(sections.length) < tileMinWidth * screen.fontScale
      ? 2
      : sections.length;
  const tileWidth = across(columns);
  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.tiles}
    >
      {sections.map((section) => (
        <Tile
          key={section}
          onChoose={props.onChoose}
          section={section}
          selected={section === props.shown}
          width={tileWidth}
          {...tileState(section, places, family)}
        />
      ))}
    </View>
  );
});

function tileState(
  section: AroundSection,
  places: readonly AroundPlace[],
  family: TaskFamily,
): {
  readonly count: number;
  readonly glyph: ReactNode;
  readonly needsYou: number;
  readonly working: number;
} {
  switch (section) {
    case "places": {
      const glyphs = new Set(places.map(({ glyph }) => glyph));
      return {
        count: places.length,
        glyph: (
          <Symbol
            name={glyphs.size === 1 ? places[0]!.glyph : "rectangle.on.rectangle"}
            size={15}
            tint={color.text}
          />
        ),
        needsYou: 0,
        working: places.filter(({ working }) => working).length,
      };
    }
    case "tasks":
      return {
        count: family.running.length,
        glyph: (
          <TaskMarks
            ground={color.surfaceRaised}
            marks={runningInOrder(family)
              .slice(0, familyGlanceMarks)
              .map(({ mark }) => mark)}
          />
        ),
        needsYou: family.running.filter(({ needsYou }) => needsYou).length,
        working: family.running.filter(({ tone }) => tone === "working").length,
      };
    case "earlier":
      return {
        count: family.earlier.length,
        glyph: <Symbol name="checklist" size={15} tint={color.muted} />,
        needsYou: 0,
        working: 0,
      };
    case "schedules":
      return {
        count: family.automations.length,
        glyph: <Symbol name="clock" size={15} tint={color.muted} />,
        needsYou: 0,
        working: 0,
      };
  }
}

function Tile(props: {
  readonly count: number;
  readonly glyph: ReactNode;
  readonly needsYou: number;
  readonly onChoose: (section: AroundSection) => void;
  readonly section: AroundSection;
  readonly selected: boolean;
  readonly width: number;
  readonly working: number;
}): ReactNode {
  const label = sectionLabel[props.section];
  const ink = props.selected ? color.ember : color.muted;
  return (
    <Pressable
      accessibilityLabel={[
        label,
        props.count,
        props.needsYou > 0 && `${props.needsYou} ${props.needsYou === 1 ? "needs" : "need"} you`,
        props.working > 0 && `${props.working} working`,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="tab"
      accessibilityState={{ selected: props.selected }}
      onPress={() => {
        if (!props.selected) props.onChoose(props.section);
      }}
      style={({ pressed }) => [
        styles.tile,
        { width: props.width },
        props.selected && styles.tileSelected,
        pressed && !props.selected && styles.tilePressed,
      ]}
    >
      <View style={styles.tileTop}>
        {props.glyph}
        {props.needsYou > 0 ? (
          <StatusDot size={6} tone="amber" />
        ) : props.working > 0 ? (
          <StatusDot live size={6} tone="green" />
        ) : null}
      </View>
      <AppText role="title" style={props.selected ? styles.tileCountSelected : null}>
        {props.count}
      </AppText>
      {/* A label shrinks a little before it would be cut; past that the tiles wrap. */}
      <Text
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        numberOfLines={1}
        style={[type.caption, { color: ink }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

interface RowActions {
  readonly blocked: boolean;
  readonly hostClient: HostClient;
  readonly openPlace: (place: AroundPlace) => void;
  readonly openSchedule: (triggerId: string) => void;
  readonly openThread: (threadId: string) => void;
}

type AroundRow =
  | { readonly kind: "place"; readonly key: string; readonly place: AroundPlace }
  | { readonly kind: "task"; readonly key: string; readonly task: FamilyTask }
  | { readonly kind: "schedule"; readonly key: string; readonly automation: ThreadAutomation };

interface AroundGroup {
  readonly key: string;
  readonly title: string | null;
  readonly data: readonly AroundRow[];
}

const taskRow = (task: FamilyTask): AroundRow => ({ key: task.threadId, kind: "task", task });

function sectionGroups(
  section: AroundSection,
  places: readonly AroundPlace[],
  family: TaskFamily,
  now: number,
): readonly AroundGroup[] {
  switch (section) {
    case "places":
      return [
        {
          data: places.map((place) => ({ key: place.key, kind: "place", place })),
          key: section,
          title: null,
        },
      ];
    case "tasks":
      return [{ data: runningInOrder(family).map(taskRow), key: section, title: null }];
    case "earlier":
      return earlierDays(family.earlier, now).map((day) => ({
        data: day.tasks.map(taskRow),
        key: day.title,
        title: day.title,
      }));
    case "schedules":
      return [
        {
          data: family.automations.map((automation) => ({
            automation,
            key: automation.id,
            kind: "schedule",
          })),
          key: section,
          title: null,
        },
      ];
  }
}

/**
 * The sections' lists side by side, one page each, so a swipe moves between
 * them as a tap on a tile does. Every page is the sheet's own height: moving
 * between them never resizes the sheet.
 */
function Pages(props: {
  readonly inset: ViewStyle;
  readonly family: TaskFamily;
  readonly onChoose: (section: AroundSection) => void;
  readonly places: readonly AroundPlace[];
  readonly rows: RowActions;
  readonly sections: readonly AroundSection[];
  readonly shown: AroundSection;
}): ReactNode {
  const { family, onChoose, places, sections } = props;
  const screen = useWindowDimensions();
  const [measured, setWidth] = useState<number | null>(null);
  const width = measured ?? screen.width;
  const pager = useRef<FlatList<AroundSection>>(null);
  const index = Math.max(0, sections.indexOf(props.shown));
  // A tile, or a section appearing or emptying, moves the pager to the shown
  // page; where a swipe already stopped, that is no move at all.
  useLayoutEffect(() => {
    pager.current?.scrollToOffset({ animated: true, offset: index * width });
  }, [index, width]);
  const pages = useMemo(() => {
    const now = Date.now();
    return new Map(
      sections.map((section) => [section, sectionGroups(section, places, family, now)]),
    );
  }, [family, places, sections]);
  const onSwipe = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const section = sections[Math.round(event.nativeEvent.contentOffset.x / width)];
      if (section !== undefined && section !== props.shown) onChoose(section);
    },
    [onChoose, props.shown, sections, width],
  );
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={styles.pages}>
      <FlatList
        data={sections}
        extraData={pages}
        getItemLayout={(_, at) => ({ index: at, length: width, offset: at * width })}
        horizontal
        initialScrollIndex={index}
        keyExtractor={(section) => section}
        onMomentumScrollEnd={onSwipe}
        pagingEnabled
        ref={pager}
        renderItem={({ item: section }) => (
          <View style={{ width }}>
            <Page
              groups={pages.get(section) ?? []}
              inset={props.inset}
              label={sectionLabel[section]}
              rows={props.rows}
            />
          </View>
        )}
        scrollEnabled={sections.length > 1}
        showsHorizontalScrollIndicator={false}
      />
    </View>
  );
}

const Page = memo(function Page(props: {
  readonly groups: readonly AroundGroup[];
  readonly inset: ViewStyle;
  readonly label: string;
  readonly rows: RowActions;
}): ReactNode {
  const { rows } = props;
  return (
    <SectionList
      accessibilityLabel={props.label}
      contentContainerStyle={props.inset}
      keyExtractor={(row) => row.key}
      renderItem={({ index, item, section }) => (
        <View
          style={[
            styles.cell,
            index === 0 && styles.cellFirst,
            index === section.data.length - 1 && styles.cellLast,
            index > 0 && styles.cellSeparated,
          ]}
        >
          {item.kind === "place" ? (
            <PlaceRow onOpen={rows.openPlace} place={item.place} />
          ) : item.kind === "task" ? (
            <TaskRow onOpen={rows.openThread} task={item.task} />
          ) : (
            <ScheduleRow
              automation={item.automation}
              blocked={rows.blocked}
              hostClient={rows.hostClient}
              onOpen={rows.openSchedule}
            />
          )}
        </View>
      )}
      renderSectionHeader={({ section }) =>
        section.title === null ? (
          <View style={styles.groupGap} />
        ) : (
          <View accessibilityRole="header" style={styles.groupTitle}>
            <AppText role="caption" tone="muted">
              {section.title}
            </AppText>
          </View>
        )
      }
      sections={props.groups}
      stickySectionHeadersEnabled={false}
    />
  );
});

const placeKind = { globe: "Page", laptopcomputer: "Mac app", smartphone: "Phone" } as const;

const PlaceRow = memo(function PlaceRow(props: {
  readonly place: AroundPlace;
  readonly onOpen: (place: AroundPlace) => void;
}): ReactNode {
  const { place } = props;
  const detail = [place.working && "Working here", place.detail].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityLabel={[
        placeKind[place.glyph],
        place.title,
        place.detail,
        place.working && "agent working",
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(place)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.icon}>
        {place.favicon === null ? (
          <Symbol
            name={place.glyph}
            size={16}
            tint={place.working ? color.green : color.textSoft}
          />
        ) : (
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: place.favicon }}
            style={styles.favicon}
          />
        )}
      </View>
      <View style={styles.words}>
        <AppText numberOfLines={1} role="bodyMedium">
          {place.title}
        </AppText>
        {detail === "" ? null : (
          <AppText
            numberOfLines={1}
            role="caption"
            style={place.working ? styles.working : null}
            tone="muted"
          >
            {detail}
          </AppText>
        )}
      </View>
      <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
    </Pressable>
  );
});

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const TaskRow = memo(function TaskRow(props: {
  readonly task: FamilyTask;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const { task } = props;
  const word = task.needsYou ? "Needs you" : task.word;
  // An earlier task's day is its group's title; the row says the time.
  const time = task.finishedAt === null ? null : clock.format(Date.parse(task.finishedAt));
  const detail = [task.detail, time].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityLabel={[task.title, word, task.detail, time].filter(Boolean).join(", ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(task.threadId)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <TaskMark mark={task.mark} size={22} />
      <View style={styles.words}>
        <AppText numberOfLines={1} role="bodyMedium">
          {task.title}
        </AppText>
        {detail === "" ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {detail}
          </AppText>
        )}
      </View>
      <View style={styles.state}>
        <TaskStatus moving={task.moving} tone={task.needsYou ? "waiting" : task.tone} word={word} />
      </View>
    </Pressable>
  );
});

/**
 * A schedule, with a switch that pauses or resumes it in place. The switch
 * says what the Host last confirmed, never the tap alone, and holds still
 * while the Host is asked; a later change the Host reports wins over it.
 */
const ScheduleRow = memo(function ScheduleRow(props: {
  readonly automation: ThreadAutomation;
  readonly blocked: boolean;
  readonly hostClient: HostClient;
  readonly onOpen: (triggerId: string) => void;
}): ReactNode {
  const { automation, hostClient } = props;
  // A change in flight (paused null), or the Host's confirmation of it until
  // the thread's list says the same. The list is reread on every trigger
  // change, and the Host announces this one as it commits, ahead of the read
  // that confirms it, so a later announcement is someone else's change: from
  // then on the list, reread for it, is the truth.
  const [asked, setAsked] = useState<{
    readonly paused: boolean | null;
    readonly revision: number;
  } | null>(null);
  const revision = useHostSelector(hostClient, selectTriggerRevision);
  const [reported, setReported] = useState(automation.paused);
  if (reported !== automation.paused) {
    setReported(automation.paused);
    setAsked(null);
  } else if (
    asked !== null &&
    asked.paused !== null &&
    (asked.paused === automation.paused || revision > asked.revision)
  )
    setAsked(null);
  const paused = asked?.paused ?? automation.paused;
  const detail = automationDetail({ ...automation, paused });
  const turn = (on: boolean) => {
    const mine = { paused: null, revision };
    setAsked(mine);
    schedulesClient(hostClient)
      .act(automation.id, on ? "resume" : "pause")
      .then(
        (confirmed) =>
          setAsked((held) =>
            held === mine
              ? {
                  paused: confirmed.item.status === "paused",
                  revision: hostClient.getSnapshot().triggerRevision,
                }
              : held,
          ),
        (error: unknown) => {
          setAsked((held) => (held === mine ? null : held));
          Alert.alert(
            `${automation.name} was not changed`,
            operationDetail(error, "The schedule could not be changed."),
          );
        },
      );
  };
  return (
    <View style={styles.scheduleRow}>
      <Pressable
        accessibilityHint="Opens the schedule"
        accessibilityLabel={`${automation.name}, ${detail}`}
        accessibilityRole="button"
        onPress={() => props.onOpen(automation.id)}
        style={({ pressed }) => [styles.row, styles.scheduleOpen, pressed && styles.pressed]}
      >
        <View style={styles.icon}>
          <Symbol
            name={paused ? "pause" : automationGlyph[automation.kind]}
            size={15}
            tint={color.muted}
          />
        </View>
        <View style={styles.words}>
          <AppText numberOfLines={1} role="bodyMedium">
            {automation.name}
          </AppText>
          <AppText numberOfLines={1} role="caption" tone="muted">
            {detail}
          </AppText>
        </View>
      </Pressable>
      <View style={styles.switch}>
        <Toggle
          accessibilityHint={paused ? "Resumes the schedule" : "Pauses the schedule"}
          accessibilityLabel={automation.name}
          disabled={props.blocked || (asked !== null && asked.paused === null)}
          onChange={turn}
          value={!paused}
        />
      </View>
    </View>
  );
});

const selectTriggerRevision = (snapshot: HostSnapshot) => snapshot.triggerRevision;

const automationGlyph = { schedule: "clock", watch: "eye", webhook: "bolt" } as const;

/** The schedule's next step in the same words its own screen uses. */
function automationDetail(automation: ThreadAutomation): string {
  if (automation.paused) return "Paused";
  if (automation.kind === "watch") return "Watching";
  if (automation.kind === "webhook") return "When called";
  return automation.nextFireAt === null
    ? "Scheduled"
    : `Next ${formatMoment(automation.nextFireAt, Date.now(), true)}`;
}

function Unavailable(): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.unavailable]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail="This deployment is no longer open."
        title="This can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: color.surfaceElevated, flex: 1, paddingTop: space[16] },
  unavailable: { justifyContent: "center", padding: space[24] },
  header: { alignItems: "center", flexDirection: "row", gap: space[8], paddingLeft: space[4] },
  heading: { flex: 1 },
  close: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  from: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    marginTop: space[8],
    maxWidth: "100%",
    paddingHorizontal: space[10],
    paddingVertical: space[6],
  },
  fromWords: { flexShrink: 1 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: tileGap, marginTop: space[16] },
  tile: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    minHeight: 76,
    paddingHorizontal: space[10],
    paddingVertical: space[8],
  },
  tileSelected: { backgroundColor: color.emberWash, borderColor: color.emberLine },
  tilePressed: { backgroundColor: color.surfacePressed },
  tileTop: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 18,
  },
  tileCountSelected: { color: color.emberBright },
  pages: { flex: 1 },
  groupGap: { height: space[12] },
  groupTitle: { paddingBottom: space[6], paddingHorizontal: space[4], paddingTop: space[16] },
  cell: { backgroundColor: color.surfaceRaised, overflow: "hidden" },
  cellFirst: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  cellLast: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  cellSeparated: { borderTopColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 60,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  scheduleRow: { alignItems: "center", flexDirection: "row" },
  scheduleOpen: { flex: 1 },
  switch: { paddingRight: space[12] },
  pressed: { backgroundColor: color.surfacePressed },
  icon: {
    alignItems: "center",
    backgroundColor: color.surfacePressed,
    borderRadius: radius.xs,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  favicon: { borderRadius: 3, height: 18, width: 18 },
  words: { flex: 1, gap: space[2] },
  working: { color: color.green },
  state: { alignItems: "flex-end", maxWidth: "40%" },
  empty: { paddingHorizontal: space[4], paddingTop: space[16] },
});
