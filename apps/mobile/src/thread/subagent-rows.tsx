import {
  agentCardLabel,
  agentPhaseLabel,
  agentsCompact,
  compactAgentPhrases,
  formatDuration,
  visibleAgentMembers,
  type AgentCard,
  type AgentGroup,
  type AgentPhrase,
  type HostClient,
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
  type StyleProp,
  type TextStyle,
} from "react-native";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { color, space } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import { AppText, monoFontFamily } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AgentMark } from "./agent-mark.js";
import { SubagentStop } from "./subagent-stop.js";
import { trace } from "./trace-styles.js";

/**
 * A helper an agent started, drawn as a step of the trace: a subagent, a
 * group started together, a workflow and its phases, or a task handed to
 * another conversation. Every word, count and order comes from
 * `@opensteer/client`'s subagent model; this file only lays them out.
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
function useClock(ticking: boolean): number {
  const [frozen] = useState(Date.now);
  return useSyncExternalStore(
    ticking ? subscribeClock : noClock,
    ticking ? wholeSecond : () => frozen,
  );
}

/** The elapsed time alone redraws each second; the row around it does not. */
export function Elapsed(props: {
  readonly endedAt: string | null;
  readonly startedAt: string;
  readonly style?: StyleProp<TextStyle>;
}): ReactNode {
  const live = useContext(AgentsLive);
  const now = useClock(live && props.endedAt === null);
  const end = props.endedAt === null ? now : Date.parse(props.endedAt);
  return (
    <AppText role="caption" style={[trace.figures, styles.time, props.style]} tone="muted">
      {formatDuration(Math.max(0, end - Date.parse(props.startedAt)))}
    </AppText>
  );
}

/* ---- What the rows need from the screen they are on ---- */

/** Whether the Host is in reach, so elapsed time still moves. */
export const AgentsLive = createContext(true);
/** Where a row goes when pressed, and the Host it stops through. */
export interface AgentScope {
  readonly hostClient?: HostClient;
  readonly onOpen: (card: AgentCard) => void;
  /** A task's own row: its menu and Stop belong to the conversation's task lines. */
  readonly renderTask?: (
    card: AgentCard,
    row: { readonly compact?: boolean; readonly noun?: boolean },
  ) => ReactNode;
}

const AgentScopeContext = createContext<AgentScope | null>(null);
export const AgentScopeProvider = AgentScopeContext;

/**
 * The reader's choices about groups and phases, held by the pane rather than
 * the rows, so a row that leaves the list's mounted window and comes back is
 * still open or closed as they left it.
 */
export const AgentMemoryContext = createContext<Map<string, boolean>>(new Map());

/** Set where the rows stand inside a virtualized list, so a long group can window with it. */
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

/* ---- A row's second line ---- */

/** Its phrases, each in words, separated as the trace separates them. */
export function AgentPhrases(props: {
  /** Something already stands before the first phrase, so it starts with a separator. */
  readonly after?: boolean;
  readonly lines?: number;
  readonly noun?: string | null;
  readonly phrases: readonly AgentPhrase[];
}): ReactNode {
  const noun = props.noun ?? null;
  return (
    <AppText numberOfLines={props.lines ?? 1} role="caption" tone="muted">
      {noun === null ? null : (
        <AppText role="caption" style={styles.noun} tone="muted">
          {noun}
        </AppText>
      )}
      {props.phrases.map((phrase, index) => (
        <AppText key={index} role="caption" style={phraseStyle(phrase.tone)} tone="muted">
          {index > 0 || noun !== null || props.after === true ? (
            <AppText role="caption" style={styles.separator} tone="muted">
              {" · "}
            </AppText>
          ) : null}
          {phrase.text}
        </AppText>
      ))}
    </AppText>
  );
}

function phraseStyle(tone: AgentPhrase["tone"]) {
  switch (tone) {
    case "attention":
      return styles.attention;
    case "failed":
      return styles.failed;
    case "live":
      return styles.live;
    case "quiet":
      return undefined;
  }
}

/** The live line rolls in as itself when it changes; nothing else about the row moves. */
function SecondLine(props: {
  readonly lines: number;
  readonly noun: string | null;
  readonly phrases: readonly AgentPhrase[];
}): ReactNode {
  const live = props.phrases.find((phrase) => phrase.tone === "live")?.text ?? null;
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View entering={appear} key={live ?? "still"}>
        <AgentPhrases lines={props.lines} noun={props.noun} phrases={props.phrases} />
      </Animated.View>
    </LayoutAnimationConfig>
  );
}

/* ---- Rows ---- */

/** From this text size a title may wrap to a second line. */
const largeText = 1.35;

function useLines(): number {
  return useWindowDimensions().fontScale >= largeText ? 2 : 1;
}

interface AgentRowProps {
  readonly card: AgentCard;
  /** Thirty or more beside it: one line, title and state. */
  readonly compact?: boolean;
  /** Alone in its place, so line two says what it is. */
  readonly noun?: boolean;
  /** Who does a delegated task, spoken in its name. */
  readonly owner?: string | null;
  readonly accessibilityActions?: readonly { readonly label: string; readonly name: string }[];
  readonly onAccessibilityAction?: (name: string) => void;
}

/**
 * One subagent, workflow member or task: a trace step with two lines, the
 * engine's mark and the time. It opens the subagent, or a task's own
 * conversation; the ones it started itself hang one step in under it.
 */
export const AgentRow = memo(function AgentRow(props: AgentRowProps): ReactNode {
  const scope = useContext(AgentScopeContext);
  if (scope === null) return null;
  if (props.card.origin === "task" && scope.renderTask) return scope.renderTask(props.card, props);
  return <AgentStep {...props} />;
});

/** The row itself; a long press on its head offers Stop where its engine allows one. */
export function AgentStep(props: AgentRowProps): ReactNode {
  const scope = useContext(AgentScopeContext);
  const lines = useLines();
  if (scope === null) return null;
  const { card } = props;
  const compact = props.compact === true;
  const children = card.children;
  const head = (
    actions: AgentRowProps["accessibilityActions"],
    onAction: AgentRowProps["onAccessibilityAction"],
  ) => (
    <Pressable
      accessibilityActions={actions ?? []}
      accessibilityLabel={agentCardLabel(card, Date.now(), props.owner ?? null)}
      accessibilityRole="button"
      disabled={card.opens === null}
      onAccessibilityAction={({ nativeEvent }) => onAction?.(nativeEvent.actionName)}
      onPress={() => scope.onOpen(card)}
      style={({ pressed }) => [trace.step, pressed && trace.pressed]}
    >
      <View style={[trace.icon, styles.iconTop]}>
        <AgentMark card={card} />
      </View>
      {compact ? (
        <View style={trace.stepText}>
          <AppText numberOfLines={lines} role="caption" tone="muted">
            <AppText role="caption" style={styles.compactTitle} tone="soft">
              {card.title}
            </AppText>
            {"  "}
            {compactAgentPhrases(card).map((phrase, index) => (
              <AppText key={index} role="caption" style={phraseStyle(phrase.tone)} tone="muted">
                {index > 0 ? " · " : ""}
                {phrase.text}
              </AppText>
            ))}
          </AppText>
        </View>
      ) : (
        <View style={trace.stepText}>
          <AppText numberOfLines={lines} role="secondary" tone="soft">
            {card.title}
          </AppText>
          <SecondLine
            lines={lines}
            noun={props.noun === true ? card.noun : null}
            phrases={card.detail}
          />
        </View>
      )}
      <Elapsed endedAt={card.endedAt} startedAt={card.startedAt} />
      {card.opens === null ? null : <Symbol name="chevron.right" size={11} tint={color.muted} />}
    </Pressable>
  );
  return (
    <View>
      {scope.hostClient === undefined || card.stop === null ? (
        head(props.accessibilityActions, props.onAccessibilityAction)
      ) : (
        <SubagentStop card={card} hostClient={scope.hostClient}>
          {(onStop) =>
            head(
              [
                {
                  label: `Stop ${card.kind === "workflow" ? "workflow" : "subagent"}`,
                  name: "stop",
                },
              ],
              (name) => {
                if (name === "stop") onStop();
              },
            )
          }
        </SubagentStop>
      )}
      {children.length > 0 ? (
        <View style={trace.lines}>
          <Members cards={children} compact={agentsCompact(children.length)} memoryKey={card.key} />
        </View>
      ) : null}
    </View>
  );
}

/** A disclosure row on the trace: a group, a workflow or a phase. */
function FoldRow(props: {
  readonly children: ReactNode;
  readonly detail: readonly AgentPhrase[];
  readonly label: string;
  readonly mark: ReactNode;
  readonly name: string;
  readonly noun?: string | null;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly time?: ReactNode;
}): ReactNode {
  const lines = useLines();
  return (
    <View>
      <Pressable
        accessibilityLabel={props.name}
        accessibilityRole="button"
        accessibilityState={{ expanded: props.open }}
        onPress={props.onToggle}
        style={({ pressed }) => [trace.step, pressed && trace.pressed]}
      >
        <View style={[trace.icon, styles.iconTop]}>{props.mark}</View>
        <View style={trace.stepText}>
          <AppText numberOfLines={lines} role="secondary" tone="soft">
            {props.label}
          </AppText>
          <AgentPhrases lines={lines} noun={props.noun ?? null} phrases={props.detail} />
        </View>
        {props.time ?? null}
        <Symbol name={props.open ? "chevron.down" : "chevron.right"} size={11} tint={color.muted} />
      </Pressable>
      {props.open ? (
        <Animated.View entering={appear} exiting={exit} style={trace.lines}>
          {props.children}
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * Subagents or tasks that started together: one alone is its own row; several
 * share one row that counts them and opens in place onto the trace's guide.
 * It starts open while any is live; the reader's choice holds after that.
 */
export const AgentGroupRow = memo(function AgentGroupRow(props: {
  readonly group: AgentGroup;
}): ReactNode {
  const { group } = props;
  const [open, setOpen] = useRemembered(`group:${group.key}`, group.live);
  const only = group.cards.length === 1 ? group.cards[0] : undefined;
  if (only !== undefined)
    return only.workflow ? <WorkflowRow card={only} /> : <AgentRow card={only} noun />;
  const nouns = group.noun === "task" ? "tasks" : "subagents";
  return (
    <FoldRow
      detail={group.detail}
      label={group.label}
      mark={<AgentMark card={group.lead} />}
      name={`${group.name}. ${open ? "Hide" : "Show"} ${nouns}`}
      onToggle={() => setOpen(!open)}
      open={open}
      time={<Elapsed endedAt={group.endedAt} startedAt={group.startedAt} />}
    >
      <Members cards={group.cards} compact={group.compact} memoryKey={group.key} />
    </FoldRow>
  );
});

/**
 * An open group's, phase's or subagent's members: the first eight in the
 * order they started, any that need the reader past that, then the way to
 * the rest. In a long transcript the list windows with the transcript's own.
 */
function Members(props: {
  readonly cards: readonly AgentCard[];
  readonly compact: boolean;
  readonly memoryKey: string;
}): ReactNode {
  const nested = useContext(AgentListNestedContext);
  const [all, setAll] = useRemembered(`all:${props.memoryKey}`, false);
  const { cards, remaining } = visibleAgentMembers(props.cards, all);
  const row = (card: AgentCard) =>
    card.workflow ? (
      <WorkflowRow card={card} key={card.key} />
    ) : (
      <AgentRow card={card} compact={props.compact} key={card.key} />
    );
  return (
    <>
      {nested && cards.length > 8 ? (
        <FlatList
          data={cards}
          keyExtractor={(card) => card.key}
          renderItem={({ item }) => row(item)}
          scrollEnabled={false}
        />
      ) : (
        cards.map(row)
      )}
      {remaining === 0 ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setAll(true)}
          style={({ pressed }) => [trace.step, trace.stepCompact, pressed && trace.pressed]}
        >
          <View style={trace.icon} />
          <AppText role="caption" tone="muted">
            Show {remaining} more
          </AppText>
        </Pressable>
      )}
    </>
  );
}

/** A workflow: its row, and its phases as numbered rows with their members under them. */
export const WorkflowRow = memo(function WorkflowRow(props: {
  readonly card: AgentCard;
}): ReactNode {
  const { card } = props;
  const scope = useContext(AgentScopeContext);
  const [open, setOpen] = useRemembered(`workflow:${card.key}`, card.endedAt === null);
  if (card.workflow === null) return null;
  return (
    <FoldRow
      detail={card.detail}
      label={card.title}
      mark={<AgentMark card={card} />}
      name={`${agentCardLabel(card, Date.now())}. ${open ? "Hide" : "Show"} phases`}
      noun="Workflow"
      onToggle={() => setOpen(!open)}
      open={open}
      time={<Elapsed endedAt={card.endedAt} startedAt={card.startedAt} />}
    >
      <WorkflowPhases card={card} />
      {scope && card.opens ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => scope.onOpen(card)}
          style={({ pressed }) => [trace.step, trace.stepCompact, pressed && trace.pressed]}
        >
          <View style={trace.icon} />
          <AppText role="caption" tone="muted">
            Open workflow
          </AppText>
        </Pressable>
      ) : null}
    </FoldRow>
  );
});

/** A workflow's phases, for its row and for its own opened view. */
export function WorkflowPhases(props: { readonly card: AgentCard }): ReactNode {
  const workflow = props.card.workflow;
  if (workflow === null) return null;
  return workflow.phases.map((phase, position) => (
    <PhaseRow
      cardKey={props.card.key}
      key={phase.index}
      open={workflow.openPhase === phase.index}
      phase={phase}
      position={position + 1}
    />
  ));
}

function PhaseRow(props: {
  readonly cardKey: string;
  readonly open: boolean;
  readonly phase: WorkflowView["phases"][number];
  readonly position: number;
}): ReactNode {
  const { phase, position } = props;
  const [open, setOpen] = useRemembered(`phase:${props.cardKey}:${phase.index}`, props.open);
  const number = (
    <AppText role="caption" style={[trace.figures, styles.number]} tone="muted">
      {position}
    </AppText>
  );
  if (phase.members.length === 0)
    return (
      <View
        accessibilityLabel={agentPhaseLabel(phase, position)}
        accessible
        style={[trace.step, trace.stepCompact]}
      >
        <View style={trace.icon}>{number}</View>
        <View style={trace.stepText}>
          <AppText numberOfLines={1} role="caption" tone="muted">
            <AppText role="secondary" tone="muted">
              {phase.title}
            </AppText>
            {"  "}
            {phase.detail.map((part) => part.text).join(" · ")}
          </AppText>
        </View>
      </View>
    );
  return (
    <FoldRow
      detail={phase.detail}
      label={phase.title}
      mark={number}
      name={`${agentPhaseLabel(phase, position)}. ${open ? "Hide" : "Show"} subagents`}
      onToggle={() => setOpen(!open)}
      open={open}
    >
      <Members
        cards={phase.members}
        compact={agentsCompact(phase.members.length)}
        memoryKey={`${props.cardKey}:${phase.index}`}
      />
    </FoldRow>
  );
}

const styles = StyleSheet.create({
  attention: { color: color.amber },
  compactTitle: { fontWeight: "500" },
  failed: { color: color.red },
  iconTop: { alignSelf: "flex-start", paddingTop: space[2] },
  live: { color: color.textSoft },
  noun: { fontWeight: "500" },
  number: { fontFamily: monoFontFamily, fontSize: 11 },
  separator: { opacity: 0.6 },
  time: { alignSelf: "flex-start", paddingTop: space[2] },
});
