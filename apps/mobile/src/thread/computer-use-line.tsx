import { turnState, type HostClient, type Turn } from "@opensteer/client/host";
import {
  computerUseNow,
  computerUseStop,
  computerUseStopLabel,
  computerUseStops,
  computerUseStopSentence,
  type ComputerUseNow,
  type ComputerUseStop,
} from "@opensteer/client/integrations";
import { useComputerUseStop, useComputerUseStopForRun } from "@opensteer/client/react";
import type { MachineSummary } from "@opensteer/protocol";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, radius, space } from "../theme.js";
import { appear } from "../ui/motion.js";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * The reader's Macs, the client that stops one, and the Stop the Run at work
 * keeps on its line, from the pane that owns them. Transcript rows are
 * memoized on their entries, and a session opens and ends without touching
 * one, so the line reads them from here.
 */
export interface TranscriptComputers {
  readonly hostClient: HostClient;
  /** The Stop the Thread's Run at work keeps once its session has gone (`useKeptComputerStop`). */
  readonly kept: ComputerUseStop | null;
  readonly machines: readonly MachineSummary[];
}

export const TranscriptComputersContext = createContext<TranscriptComputers | null>(null);

/** What a live turn's line says about the reader's Mac. */
export type ComputerLine =
  | { readonly kind: "kept"; readonly stop: ComputerUseStop }
  | { readonly kind: "now"; readonly now: ComputerUseNow };

/**
 * A live turn's line about the reader's Mac: the session it is working in, or
 * else the Stop it keeps after that session has gone; null when the reader is
 * shown neither, or the transcript cannot confirm what is live and says so in
 * its own status instead. The pane asks the same of every turn of a
 * conversation, so a turn that would draw only this line is drawn exactly
 * while there is one.
 */
export function computerLine(
  turn: Turn,
  computers: TranscriptComputers | null,
  live: boolean,
): ComputerLine | null {
  if (!live || computers === null) return null;
  const now = computerUseNow(turn, computers.machines);
  if (now !== null) return { kind: "now", now };
  const { kept } = computers;
  return kept !== null && kept.runId === turn.runId && turnState(turn) !== "settled"
    ? { kind: "kept", stop: kept }
    : null;
}

/** A row's `computerLine`, from the pane's Macs and kept Stop. */
export function useComputerLine(turn: Turn, live: boolean): ComputerLine | null {
  const computers = useContext(TranscriptComputersContext);
  return useMemo(() => computerLine(turn, computers, live), [computers, live, turn]);
}

/** A task turn's folded steps, which its status line opens and closes. */
export interface StepsToggle {
  readonly onToggle: () => void;
  readonly open: boolean;
}

/** Where a turn on the reader's Mac is, and — for a task's turn — the way into its steps. */
function Where(props: {
  readonly children: ReactNode;
  readonly toggle: StepsToggle | null;
}): ReactNode {
  const { toggle } = props;
  if (toggle === null) return <View style={styles.where}>{props.children}</View>;
  return (
    <Pressable
      accessibilityHint={toggle.open ? "Hides this reply's steps" : "Shows this reply's steps"}
      accessibilityRole="button"
      accessibilityState={{ expanded: toggle.open }}
      onPress={toggle.onToggle}
      style={({ pressed }) => [styles.where, pressed && styles.pressed]}
    >
      {props.children}
      <Symbol name={toggle.open ? "chevron.down" : "chevron.right"} size={11} tint={color.muted} />
    </Pressable>
  );
}

/**
 * The turn's status while it works on the reader's Mac, as the web draws it:
 * the Mac as the agent's ember mark, what it is doing, then where, and Stop.
 * It arrives once and holds still, so a step changing its words is the only
 * news. The app itself opens from its chip under the line, the one way to it.
 */
export function ComputerUseLine(props: {
  readonly now: ComputerUseNow;
  readonly toggle?: StepsToggle | null;
}): ReactNode {
  const { now } = props;
  const computers = useContext(TranscriptComputersContext);
  const hostClient = computers?.hostClient ?? null;
  // The outcome belongs to the session, not to this line: the line leaves
  // with the session, which the Host forgets before the Mac has answered.
  const stop = useComputerUseStop(hostClient, now.session.sessionId);
  const stopping = stop?.phase === "stopping" || stop?.phase === "stopped";
  // A Stop that did not happen is said here, and the same Stop tries again.
  const failure = stop?.phase === "failed" ? stop : null;
  return (
    <Animated.View entering={appear} style={styles.block}>
      <View style={styles.line}>
        <Where toggle={props.toggle ?? null}>
          <View style={styles.glyph}>
            <Symbol
              name={now.kind === "phone" ? "smartphone" : "laptopcomputer"}
              size={15}
              tint={color.ember}
              weight="semibold"
            />
          </View>
          <View style={styles.text}>
            <AppText numberOfLines={1} role="secondaryMedium">
              {now.action}
            </AppText>
            {failure === null ? (
              <AppText numberOfLines={1} role="caption" tone="muted">
                {now.place}
              </AppText>
            ) : (
              <View accessibilityLiveRegion="polite" accessibilityRole="alert">
                <AppText role="caption" tone="danger">
                  {failure.message ?? computerUseStopSentence(failure)}
                </AppText>
              </View>
            )}
          </View>
        </Where>
        <SecondaryButton
          {...(stopping
            ? {}
            : {
                accessibilityLabel:
                  now.kind === "phone"
                    ? `Stop using phone, ${now.machine.name}`
                    : computerUseStopLabel(now.machine.name),
              })}
          compact
          disabled={stopping}
          label={
            stopping
              ? computerUseStop.busyLabel
              : now.kind === "phone"
                ? "Stop using phone"
                : computerUseStop.label
          }
          onPress={() => {
            if (hostClient === null) return;
            computerUseStops(hostClient).stop({
              machineName: now.machine.name,
              runId: now.session.runId,
              sessionId: now.session.sessionId,
            });
          }}
        />
      </View>
    </Animated.View>
  );
}

/** How long a confirmed Stop stays on the line after its session has gone. */
const keptStoppedMs = 3_000;

/**
 * A Run's Stop whose session has left the Mac's list before, or as, it was
 * answered. While the turn is still at work its line says so — `Stopping…`,
 * then `Stopped using Mac mini` for a moment — instead of reading as ordinary
 * work. A Stop that failed is not kept: with its session gone there is
 * nothing left to stop. The pane holds it for its Run at work and hands it to
 * `computerLine`, so the list and the row agree on the row it keeps.
 */
export function useKeptComputerStop(
  hostClient: HostClient,
  runId: string | null,
): ComputerUseStop | null {
  const stop = useComputerUseStopForRun(hostClient, runId);
  const settledAt = stop?.phase === "stopped" ? stop.settledAt : null;
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (settledAt === null) return;
    const timer = setTimeout(
      () => setExpired(settledAt),
      Math.max(0, keptStoppedMs - (performance.now() - settledAt)),
    );
    return () => clearTimeout(timer);
  }, [settledAt]);
  if (stop === null || stop.phase === "failed") return null;
  if (
    settledAt !== null &&
    (expired === settledAt || performance.now() - settledAt >= keptStoppedMs)
  ) {
    return null;
  }
  return stop;
}

/** The line a Stop leaves behind while its answer is on the way or just in. */
export function KeptComputerStopLine(props: {
  readonly stop: ComputerUseStop;
  readonly toggle?: StepsToggle | null;
}): ReactNode {
  const { stop } = props;
  return (
    <Animated.View entering={appear} style={styles.block}>
      <View style={styles.line}>
        <Where toggle={props.toggle ?? null}>
          <View style={styles.glyph}>
            <Symbol name="laptopcomputer" size={15} tint={color.ember} weight="semibold" />
          </View>
          <View accessibilityLiveRegion="polite" style={styles.text}>
            <AppText numberOfLines={1} role="secondaryMedium">
              {computerUseStopSentence(stop)}
            </AppText>
            {stop.phase === "stopping" ? (
              <AppText numberOfLines={1} role="caption" tone="muted">
                {`On ${stop.machineName}`}
              </AppText>
            ) : null}
          </View>
        </Where>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space[6] },
  glyph: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderRadius: radius.full,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  line: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 44,
    paddingVertical: space[2],
  },
  pressed: { opacity: 0.7 },
  text: { flex: 1, gap: 1, minWidth: 0 },
  where: { alignItems: "center", flex: 1, flexDirection: "row", gap: space[12], minWidth: 0 },
});
