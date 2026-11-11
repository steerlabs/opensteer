import {
  formatDuration,
  isActiveSubagent,
  visibleAgentMembers,
  type AgentCard,
  type HostClient,
  type AgentGroup,
  type AgentTone,
  type WorkflowView,
} from "@opensteer/client/host";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { color, material, radius, space, touchTarget } from "../theme.js";
import { appear, enter, exit, move } from "../ui/motion.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { SubagentStop } from "./subagent-stop.js";
import { samePlain } from "./agent-select.js";

/**
 * A helper an agent started, drawn as one card: an engine's subagent, a
 * workflow, or a task handed to another conversation. Every word, count and
 * default comes from `@opensteer/client`'s subagent model; this file only
 * lays them out for a phone.
 */

/* ---- One clock for every elapsed label ---- */

const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  clockTimer ??= setInterval(() => {
    for (const tick of clockListeners) tick();
  }, 1_000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const noClock = () => () => undefined;
const wholeSecond = () => Math.floor(Date.now() / 1_000) * 1_000;

/** Now, to the second, while `ticking`; one shared timer drives every caller. */
export function useClock(ticking: boolean): number {
  const [frozen] = useState(Date.now);
  return useSyncExternalStore(
    ticking ? subscribeClock : noClock,
    ticking ? wholeSecond : () => frozen,
  );
}

function elapsed(startedAt: string, endedAt: string | null, now: number): number {
  return Math.max(0, Date.parse(endedAt ?? new Date(now).toISOString()) - Date.parse(startedAt));
}

/** "1m 12s" said as words, which a screen reader otherwise spells out. */
export function spokenDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  const parts: string[] = [];
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (rest || parts.length === 0) parts.push(`${rest} ${rest === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/** The elapsed time alone redraws each second; the card around it does not. */
function Elapsed(props: {
  readonly endedAt: string | null;
  readonly live: boolean;
  readonly startedAt: string;
}): ReactNode {
  const now = useClock(props.live && props.endedAt === null);
  return (
    <AppText role="caption" style={styles.figures} tone="muted">
      {formatDuration(elapsed(props.startedAt, props.endedAt, now))}
    </AppText>
  );
}

/* ---- What the cards need from the screen they are on ---- */

/** Where a card goes when pressed, and whether the Host is in reach so time still moves. */
export interface AgentScope {
  readonly hostClient?: HostClient;
  readonly live: boolean;
  readonly onOpen: (card: AgentCard) => void;
  /** A task card's own row: its menu and Stop belong to the conversation's task lines. */
  readonly renderTask?: (card: AgentCard) => ReactNode;
}

/**
 * The reader's choices about groups and phases, held by the pane rather than
 * the rows, so a row that leaves the list's mounted window and comes back is
 * still open or closed as they left it.
 */
export const AgentMemoryContext = createContext<Map<string, boolean>>(new Map());

/** Set where the cards stand inside a virtualized list, so a long group can window with it. */
export const AgentListNestedContext = createContext(false);

function useRemembered(
  key: string,
  fallback: boolean,
): readonly [boolean, (open: boolean) => void] {
  const memory = useContext(AgentMemoryContext);
  const [chosen, setChosen] = useState(() => memory.get(key));
  const choose = useCallback(
    (open: boolean) => {
      memory.set(key, open);
      setChosen(open);
    },
    [key, memory],
  );
  return [chosen ?? fallback, choose];
}

/**
 * A helper's lifecycle said aloud once, while the conversation is in front of
 * the reader. Progress and time are never announced.
 */
export function AgentNews(props: {
  readonly cards: readonly AgentCard[];
  readonly focused: boolean;
}) {
  return props.cards.map((card) => (
    <CardNews focused={props.focused} key={card.key} text={card.announcement} />
  ));
}

function CardNews(props: { readonly focused: boolean; readonly text: string }): null {
  const said = useRef(props.text);
  useEffect(() => {
    if (said.current === props.text) return;
    said.current = props.text;
    if (props.focused) AccessibilityInfo.announceForAccessibility(props.text);
  }, [props.focused, props.text]);
  return null;
}

/* ---- The card ---- */

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Below this pane width the inner screen of a folding phone has no room for the model. */
const narrowWidth = 340;
/** From this text size the title may wrap and the elapsed time joins the word. */
const largeText = 1.35;

export function dotProps(tone: AgentTone | "pending"): {
  readonly tone: "amber" | "ember" | "muted" | "red";
  readonly ring?: boolean;
  readonly opacity?: number;
} {
  switch (tone) {
    case "working":
      return { tone: "ember" };
    case "needs-you":
      return { tone: "amber" };
    case "finished":
      return { opacity: 0.7, tone: "muted" };
    case "failed":
      return { tone: "red" };
    case "stopped":
      return { ring: true, tone: "muted" };
    case "waiting":
    case "pending":
      return { tone: "muted" };
  }
}

function lineColor(kind: NonNullable<AgentCard["line"]>["kind"]): string {
  switch (kind) {
    case "progress":
    case "error":
      return color.textSoft;
    case "question":
      return color.amber;
    case "result":
      return color.muted;
    case "prompt":
      return color.mutedDim;
  }
}

function kindWord(card: AgentCard): string | null {
  return card.origin === "task" ? "Task" : card.kind === "workflow" ? "Workflow" : null;
}

function cardLabel(card: AgentCard, now: number, owner: string | null = null): string {
  if (card.origin === "task")
    return `${card.title}${owner ? `, ${owner}` : ""}, task, ${card.word}. Open task`;
  const time = spokenDuration(elapsed(card.startedAt, card.endedAt, now));
  if (card.workflow) {
    const open = card.workflow.phases.findIndex(
      (phase) => phase.index === card.workflow?.openPhase,
    );
    return [
      `${card.title}, workflow, ${card.word}`,
      open < 0 ? null : `phase ${open + 1} of ${card.workflow.phases.length}`,
      card.modelLabel,
      time,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return `${[card.title, "subagent", card.word, card.modelLabel, time].filter(Boolean).join(", ")}${
    card.line ? `. ${card.line.text}` : ""
  }`;
}

/**
 * One card's row: title and elapsed time; dot, word and model; and the one
 * line of what it is doing or did. While it runs that line is exactly one line,
 * so streaming never changes the row's height.
 */
interface AgentCardRowProps {
  readonly card: AgentCard;
  readonly live: boolean;
  readonly onOpen: (card: AgentCard) => void;
  /** Who does a delegated task, spoken in its name. */
  readonly owner?: string | null;
  readonly accessibilityActions?: readonly { readonly label: string; readonly name: string }[];
  readonly onAccessibilityAction?: (name: string) => void;
  /**
   * In the roster's earlier days: the time of day it ended where the elapsed
   * time stands, and how long it took after its word.
   */
  readonly ended?: boolean;
}

export const AgentCardRow = memo(function AgentCardRow(props: AgentCardRowProps): ReactNode {
  const { card } = props;
  const { fontScale, width } = useWindowDimensions();
  const narrow = width < narrowWidth;
  const large = fontScale >= largeText;
  const active = isActiveSubagent(card);
  const kind = kindWord(card);
  const ended = props.ended === true ? card.endedAt : null;
  const after =
    ended !== null
      ? formatDuration(elapsed(card.startedAt, ended, 0))
      : narrow
        ? null
        : card.modelLabel;
  const time =
    ended !== null ? (
      <AppText role="caption" style={styles.figures} tone="muted">
        {clock.format(Date.parse(ended))}
      </AppText>
    ) : (
      <Elapsed endedAt={card.endedAt} live={props.live} startedAt={card.startedAt} />
    );
  const content = (
    <>
      <View style={styles.mark}>
        {card.task ? (
          <TaskMark mark={card.task.mark} size={20} />
        ) : (
          <Symbol
            name={card.kind === "workflow" ? "list.bullet" : "sparkles"}
            size={14}
            tint={color.mutedDim}
          />
        )}
      </View>
      <View style={styles.text}>
        <View style={styles.lineOne}>
          <AppText
            numberOfLines={large ? 2 : 1}
            role="secondaryMedium"
            style={styles.title}
            tone="soft"
          >
            {card.title}
          </AppText>
          {large && ended === null ? null : time}
          {card.opens === null ? null : (
            <Symbol name="chevron.right" size={11} tint={color.muted} />
          )}
        </View>
        <View style={styles.meta}>
          {kind === null ? null : <KindLabel>{kind}</KindLabel>}
          <StatusDot live={card.moving} size={6} {...dotProps(card.tone)} />
          <LayoutAnimationConfig skipEntering>
            <Animated.View entering={appear} key={card.word} style={styles.metaWords}>
              <AppText numberOfLines={large ? 2 : 1} role="caption">
                <AppText
                  role="caption"
                  style={card.tone === "needs-you" ? styles.amber : undefined}
                  tone="soft"
                >
                  {card.word}
                </AppText>
                {after === null ? null : (
                  <AppText role="caption" tone="muted">
                    {` · ${after}`}
                  </AppText>
                )}
              </AppText>
            </Animated.View>
          </LayoutAnimationConfig>
          {large && ended === null ? (
            <>
              <AppText role="caption" tone="muted">
                ·
              </AppText>
              {time}
            </>
          ) : null}
        </View>
        {card.line === null ? null : (
          <LayoutAnimationConfig skipEntering>
            <Animated.View entering={appear} key={card.line.text}>
              <AppText
                numberOfLines={active ? 1 : 2}
                role="caption"
                style={{ color: lineColor(card.line.kind) }}
              >
                {card.line.text}
              </AppText>
            </Animated.View>
          </LayoutAnimationConfig>
        )}
      </View>
    </>
  );
  // Read when the row draws; the elapsed text alone keeps time between draws.
  const label = cardLabel(card, Date.now(), props.owner);
  if (card.opens === null)
    return (
      <View accessibilityLabel={label} accessible style={styles.row}>
        {content}
      </View>
    );
  return (
    <Pressable
      accessibilityActions={props.accessibilityActions ?? []}
      accessibilityHint={
        card.origin === "task"
          ? "Opens the task"
          : card.kind === "workflow"
            ? "Opens this workflow"
            : "Opens this subagent"
      }
      accessibilityLabel={label}
      accessibilityRole="button"
      onAccessibilityAction={({ nativeEvent }) =>
        props.onAccessibilityAction?.(nativeEvent.actionName)
      }
      onPress={() => props.onOpen(card)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}, sameRowProps);

function sameRowProps(left: AgentCardRowProps, right: AgentCardRowProps): boolean {
  return (
    left.owner === right.owner &&
    left.live === right.live &&
    left.ended === right.ended &&
    left.onOpen === right.onOpen &&
    left.onAccessibilityAction === right.onAccessibilityAction &&
    samePlain(left.accessibilityActions, right.accessibilityActions) &&
    samePlain(left.card, right.card)
  );
}

function KindLabel(props: { readonly children: string }): ReactNode {
  return (
    <View style={styles.kind}>
      <AppText role="caption" style={styles.kindWord} tone="muted">
        {props.children}
      </AppText>
    </View>
  );
}

/* ---- Cards in place: one, a group, a workflow ---- */

/** The plate every card and group stands on. */
export function AgentPlate(props: { readonly children: ReactNode }): ReactNode {
  return (
    <Animated.View entering={enter} exiting={exit} layout={move} style={styles.plate}>
      {props.children}
    </Animated.View>
  );
}

/** One card in its plate, by its kind: a workflow opens its phases under its head. */
export function AgentCardView(props: { readonly card: AgentCard; readonly scope: AgentScope }) {
  const { card, scope } = props;
  if (card.workflow) return <WorkflowCard card={card} scope={scope} workflow={card.workflow} />;
  return <AgentPlate>{cardRow(card, scope)}</AgentPlate>;
}

function cardRow(card: AgentCard, scope: AgentScope): ReactNode {
  if (card.origin === "task" && scope.renderTask) return scope.renderTask(card);
  if (!scope.hostClient)
    return <AgentCardRow card={card} live={scope.live} onOpen={scope.onOpen} />;
  return (
    <SubagentStop card={card} hostClient={scope.hostClient}>
      {(onStop) => (
        <AgentCardRow
          card={card}
          live={scope.live}
          onOpen={scope.onOpen}
          accessibilityActions={
            card.stop
              ? [
                  {
                    name: "stop",
                    label: `Stop ${card.kind === "workflow" ? "workflow" : "subagent"}`,
                  },
                ]
              : []
          }
          onAccessibilityAction={(name) => {
            if (name === "stop") onStop();
          }}
        />
      )}
    </SubagentStop>
  );
}

/**
 * Adjacent helpers of one turn: one card alone is just its plate; several
 * share a header that counts them and opens or closes the list. A live group
 * starts open, a settled one closed, and the reader's own choice holds.
 */
export function AgentGroupView(props: {
  readonly group: AgentGroup;
  readonly scope: AgentScope;
}): ReactNode {
  const { group, scope } = props;
  const [open, setOpen] = useRemembered(`group:${group.key}`, group.live);
  const [all, setAll] = useRemembered(`group-all:${group.key}`, false);
  const only = group.cards.length === 1 ? group.cards[0] : undefined;
  if (only !== undefined) return <AgentCardView card={only} scope={scope} />;
  return (
    <AgentPlate>
      <GroupHead group={group} live={scope.live} onToggle={() => setOpen(!open)} open={open} />
      {open ? (
        <Animated.View entering={appear} exiting={exit} style={styles.groupBody}>
          <Members
            cards={group.cards}
            indent={false}
            onShowAll={() => setAll(true)}
            scope={scope}
            showAll={all}
          />
        </Animated.View>
      ) : null}
    </AgentPlate>
  );
}

const GroupHead = memo(
  function GroupHead(props: {
    readonly group: AgentGroup;
    readonly live: boolean;
    readonly onToggle: () => void;
    readonly open: boolean;
  }): ReactNode {
    const { group } = props;
    const { fontScale, width } = useWindowDimensions();
    const narrow = width < narrowWidth || fontScale >= largeText;
    const [noun, ...counts] = group.summary.split(" · ");
    return (
      <Pressable
        accessibilityLabel={group.summary}
        accessibilityRole="button"
        accessibilityState={{ expanded: props.open }}
        onPress={props.onToggle}
        style={({ pressed }) => [styles.row, styles.head, pressed && styles.pressed]}
      >
        <View style={styles.headMark}>
          <Symbol name="person.2" size={14} tint={color.mutedDim} />
        </View>
        <AppText numberOfLines={2} role="caption" style={styles.text} tone="muted">
          <AppText role="secondaryMedium" tone={group.live ? "soft" : "muted"}>
            {noun}
          </AppText>
          {counts.map((count, index) => (
            <AppText key={count} role="caption" tone="muted">
              {index === 0 ? (narrow ? "\n" : " · ") : " · "}
              <AppText
                role="caption"
                style={/ needs? you$/u.test(count) ? styles.amber : undefined}
                tone="muted"
              >
                {count}
              </AppText>
            </AppText>
          ))}
        </AppText>
        <Elapsed endedAt={group.endedAt} live={props.live} startedAt={group.startedAt} />
        <Symbol name={props.open ? "chevron.down" : "chevron.right"} size={11} tint={color.muted} />
      </Pressable>
    );
  },
  (left, right) =>
    left.live === right.live &&
    left.open === right.open &&
    left.onToggle === right.onToggle &&
    left.group.summary === right.group.summary &&
    left.group.live === right.group.live &&
    left.group.startedAt === right.group.startedAt &&
    left.group.endedAt === right.group.endedAt,
);

/**
 * An open group's or phase's members: the first eight in the order they
 * started, any that need the reader past that, then the way to the rest. In a
 * long transcript the whole list windows with the transcript's own.
 */
function Members(props: {
  readonly cards: readonly AgentCard[];
  readonly indent: boolean;
  readonly onShowAll: () => void;
  readonly scope: AgentScope;
  readonly showAll: boolean;
}): ReactNode {
  const nested = useContext(AgentListNestedContext);
  const { cards, remaining } = visibleAgentMembers(props.cards, props.showAll);
  const hairline = props.indent ? styles.hairlineIndented : styles.hairline;
  const row = (card: AgentCard, index: number) => (
    <Animated.View entering={enter} exiting={exit} key={card.key}>
      {index > 0 ? <View style={hairline} /> : null}
      {props.indent ? (
        <MemberRow card={card} live={props.scope.live} onOpen={props.scope.onOpen} />
      ) : (
        cardRow(card, props.scope)
      )}
    </Animated.View>
  );
  return (
    <>
      {nested && cards.length > 8 ? (
        <FlatList
          data={cards}
          keyExtractor={(card) => card.key}
          renderItem={({ index, item }) => row(item, index)}
          scrollEnabled={false}
        />
      ) : (
        cards.map(row)
      )}
      {remaining === 0 ? null : (
        <>
          <View style={hairline} />
          <Pressable
            accessibilityRole="button"
            onPress={props.onShowAll}
            style={({ pressed }) => [
              styles.more,
              props.indent && styles.moreIndented,
              pressed && styles.pressed,
            ]}
          >
            <AppText role="caption" tone="muted">
              Show {remaining} more
            </AppText>
          </Pressable>
        </>
      )}
    </>
  );
}

/**
 * A workflow: its head is a card that opens the workflow's own view, and its
 * phases stand under it, each a disclosure of the subagents it ran. Only the
 * phase at work, else the one that failed, else the last, starts open.
 */
export function WorkflowCard(props: {
  readonly card: AgentCard;
  readonly scope: AgentScope;
  readonly workflow: WorkflowView;
  /** The roster's row draws without its plate; the list around it is the plate. */
  readonly bare?: boolean;
  /** The workflow's own view, whose header already is its head. */
  readonly phasesOnly?: boolean;
}): ReactNode {
  const { card, scope, workflow } = props;
  const body = (
    <>
      {props.phasesOnly === true ? null : cardRow(card, scope)}
      {workflow.phases.map((phase, index) => (
        <Phase
          cardKey={card.key}
          first={index === 0 && props.phasesOnly === true}
          key={phase.index}
          open={phase.index === workflow.openPhase}
          phase={phase}
          scope={scope}
        />
      ))}
    </>
  );
  return props.bare === true ? <View>{body}</View> : <AgentPlate>{body}</AgentPlate>;
}

function Phase(props: {
  readonly cardKey: string;
  /** The top of its plate, where the plate's own rim already draws the line. */
  readonly first: boolean;
  readonly open: boolean;
  readonly phase: WorkflowView["phases"][number];
  readonly scope: AgentScope;
}): ReactNode {
  const { phase } = props;
  const [open, setOpen] = useRemembered(`phase:${props.cardKey}:${phase.index}`, props.open);
  const [all, setAll] = useRemembered(`phase-all:${props.cardKey}:${phase.index}`, false);
  const counts = `${phase.word} · ${phase.settled}/${phase.total}`;
  return (
    <View>
      <Pressable
        accessibilityLabel={`Phase ${phase.index + 1}, ${phase.title}, ${phase.word}, ${phase.settled} of ${phase.total} finished`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.phase,
          props.first && styles.phaseFirst,
          pressed && styles.pressed,
        ]}
      >
        <Symbol name={open ? "chevron.down" : "chevron.right"} size={11} tint={color.muted} />
        <AppText role="caption" style={[styles.figures, styles.phaseNumber]} tone="muted">
          {phase.index + 1}
        </AppText>
        <AppText numberOfLines={1} role="caption" style={styles.text} tone="soft">
          {phase.title}
        </AppText>
        <AppText
          role="caption"
          style={[styles.figures, phase.tone === "needs-you" ? styles.amber : undefined]}
          tone="muted"
        >
          {counts}
        </AppText>
      </Pressable>
      {open && phase.members.length > 0 ? (
        <Animated.View entering={appear} exiting={exit}>
          <Members
            cards={phase.members}
            indent
            onShowAll={() => setAll(true)}
            scope={props.scope}
            showAll={all}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A workflow member: its title with its word under it, its time, and the way to its view. */
const MemberRow = memo(
  function MemberRow(props: {
    readonly card: AgentCard;
    readonly live: boolean;
    readonly onOpen: (card: AgentCard) => void;
  }): ReactNode {
    const { card } = props;
    return (
      <Pressable
        accessibilityHint="Opens this subagent"
        accessibilityLabel={cardLabel(card, Date.now())}
        accessibilityRole="button"
        disabled={card.opens === null}
        onPress={() => props.onOpen(card)}
        style={({ pressed }) => [styles.member, pressed && styles.pressed]}
      >
        <View style={styles.text}>
          <AppText numberOfLines={1} role="caption" tone="soft">
            {card.title}
          </AppText>
          <View style={styles.meta}>
            <StatusDot live={card.moving} size={6} {...dotProps(card.tone)} />
            <AppText
              numberOfLines={1}
              role="caption"
              style={card.tone === "needs-you" ? styles.amber : undefined}
              tone="muted"
            >
              {card.word}
            </AppText>
          </View>
        </View>
        <Elapsed endedAt={card.endedAt} live={props.live} startedAt={card.startedAt} />
        {card.opens === null ? null : <Symbol name="chevron.right" size={11} tint={color.muted} />}
      </Pressable>
    );
  },
  (left, right) =>
    left.live === right.live && left.onOpen === right.onOpen && samePlain(left.card, right.card),
);

const styles = StyleSheet.create({
  amber: { color: color.amber },
  figures: { fontVariant: ["tabular-nums"] },
  plate: {
    ...material.plate,
    borderCurve: "continuous",
    borderRadius: radius.md,
    marginVertical: space[4],
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    gap: space[10],
    minHeight: touchTarget,
    paddingHorizontal: space[10],
    paddingVertical: space[8],
  },
  head: { alignItems: "center" },
  pressed: { ...material.quiet },
  mark: { alignItems: "center", paddingTop: space[2], width: space[20] },
  headMark: { alignItems: "center", width: space[20] },
  text: { flex: 1, gap: space[2], minWidth: 0 },
  lineOne: { alignItems: "center", flexDirection: "row", gap: space[8] },
  title: { flex: 1 },
  meta: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  metaWords: { flexShrink: 1 },
  kind: {
    ...material.quiet,
    borderRadius: radius.xs,
    paddingHorizontal: space[6],
  },
  kindWord: { fontWeight: "600" },
  groupBody: { borderTopColor: color.lineStrong, borderTopWidth: StyleSheet.hairlineWidth },
  hairline: {
    backgroundColor: color.lineStrong,
    height: StyleSheet.hairlineWidth,
    marginLeft: space[40],
  },
  hairlineIndented: {
    backgroundColor: color.lineStrong,
    height: StyleSheet.hairlineWidth,
    marginLeft: space[56],
  },
  more: {
    justifyContent: "center",
    minHeight: touchTarget,
    paddingLeft: space[40],
    paddingRight: space[10],
  },
  moreIndented: { paddingLeft: space[56] },
  phase: {
    alignItems: "center",
    borderTopColor: color.lineStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingLeft: space[32] + space[4],
    paddingRight: space[10],
  },
  phaseFirst: { borderTopWidth: 0 },
  phaseNumber: { minWidth: space[12] },
  member: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingLeft: space[56],
    paddingRight: space[10],
    paddingVertical: space[4],
  },
});
