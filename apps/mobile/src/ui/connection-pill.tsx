import {
  describeHostConnection,
  type HostClient,
  type HostConnectionLine,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { controlFontScaleLimit, material, radius, space } from "../theme.js";
import { headerBottom } from "./header-clearance.js";
import { useSelectedHostClient } from "./mobile-client-context.js";
import { appear, descend, exit, move } from "./motion.js";
import { AppText, StatusDot } from "./primitives.js";

/** What the pill says about one connection while it is interrupted. */
export interface ConnectionPillNotice {
  /** Changes only when the meaning changes; it keys the cross-fade and the announcement. */
  readonly key: string;
  readonly label: string;
  readonly tone: "muted" | "amber";
  /** An attempt is in flight: the dot breathes only then. */
  readonly trying: boolean;
  readonly action: {
    readonly label: string;
    readonly accessibilityLabel?: string;
    readonly onPress: () => void;
  } | null;
}

/**
 * Where an interrupted connection is said, once, for the whole app. It floats
 * over every screen under the focused header, so nothing moves under a reader
 * when it comes or goes. A change of state keeps the capsule and changes its
 * words; only arriving and leaving move it.
 */
export const ConnectionPillView = memo(function ConnectionPillView(props: {
  readonly notice: ConnectionPillNotice | null;
  /** A gate is explaining instead: the pill steps aside without announcing a recovery. */
  readonly gated?: boolean;
  /** Opens the connection's details; without it the words are not a button. */
  readonly onOpenDetails?: (() => void) | undefined;
  /** Chrome that owns the top edge (a call bar, a full-screen picture) sets the pill's top. */
  readonly top?: number | undefined;
  readonly detailsHint?: string;
  readonly recoveredLabel?: string;
}): ReactNode {
  const notice = props.gated === true ? null : props.notice;
  useConnectionAnnouncements(
    props.gated === true ? undefined : notice,
    props.recoveredLabel ?? "Connected",
  );
  const fallbackTop = useSafeAreaInsets().top + navigationBarClearance;
  const override = props.top;
  const anchor = useAnimatedStyle(() => ({
    top:
      override !== undefined
        ? override
        : headerBottom.value > 0
          ? headerBottom.value + space[8]
          : fallbackTop,
  }));
  const [pressed, setPressed] = useState(false);
  return (
    <Animated.View pointerEvents="box-none" style={[styles.anchor, anchor]}>
      {notice === null ? null : (
        <Animated.View
          entering={descend}
          exiting={exit}
          layout={move}
          style={[styles.pill, pressed && styles.pillPressed]}
        >
          <Pressable
            accessibilityHint={
              props.onOpenDetails === undefined
                ? undefined
                : (props.detailsHint ?? "Opens connection details.")
            }
            accessibilityLabel={notice.label}
            accessibilityRole={props.onOpenDetails === undefined ? "text" : "button"}
            disabled={props.onOpenDetails === undefined}
            onPress={props.onOpenDetails}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            style={[styles.words, notice.action === null && styles.wordsAlone]}
          >
            <StatusDot live={notice.trying} tone={notice.tone} />
            <Animated.View entering={appear} exiting={exit} key={notice.key} style={styles.label}>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="secondaryMedium"
                tone="soft"
              >
                {notice.label}
              </AppText>
            </Animated.View>
          </Pressable>
          {notice.action === null ? null : (
            <Pressable
              accessibilityLabel={notice.action.accessibilityLabel ?? notice.action.label}
              accessibilityRole="button"
              hitSlop={space[12]}
              onPress={notice.action.onPress}
              style={styles.action}
            >
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="secondaryMedium"
                tone="ember"
              >
                {notice.action.label}
              </AppText>
            </Pressable>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
});

/**
 * Says a change of meaning once. A recovery is said only after an interruption
 * was; `undefined` (a gate explaining) leaves what was said alone.
 */
function useConnectionAnnouncements(
  notice: ConnectionPillNotice | null | undefined,
  recoveredLabel: string,
): void {
  const announced = useRef(false);
  const label = useRef<string | null>(null);
  label.current = notice?.label ?? null;
  const key = notice === undefined ? undefined : (notice?.key ?? null);
  useEffect(() => {
    if (key === undefined) return;
    if (key !== null) {
      announced.current = true;
      if (label.current !== null) void AccessibilityInfo.announceForAccessibility(label.current);
    } else if (announced.current) {
      announced.current = false;
      void AccessibilityInfo.announceForAccessibility(recoveredLabel);
    }
  }, [key, recoveredLabel]);
}

/** Today's Host connection line, until the shell's connection presenter replaces it. */
export function ConnectionPill(): ReactNode {
  const hostClient = useSelectedHostClient();
  return hostClient === null ? null : <HostConnectionPill hostClient={hostClient} />;
}

type HostNotice = HostConnectionLine & { readonly trying: boolean };

const selectNotice = (snapshot: HostSnapshot): HostNotice | null =>
  snapshot.connectionInterrupted
    ? { ...describeHostConnection(snapshot), trying: snapshot.connection === "connecting" }
    : null;

const sameNotice = (left: HostNotice | null, right: HostNotice | null): boolean =>
  left?.label === right?.label && left?.trying === right?.trying;

function HostConnectionPill(props: { readonly hostClient: HostClient }): ReactNode {
  const { hostClient } = props;
  const line = useHostSelector(hostClient, selectNotice, sameNotice);
  const notice = useMemo<ConnectionPillNotice | null>(
    () =>
      line === null
        ? null
        : {
            action:
              line.action === "retry"
                ? {
                    accessibilityLabel: "Try connecting now",
                    label: "Retry",
                    onPress: () =>
                      void hostClient.refresh({ retryConnection: true }).catch(() => undefined),
                  }
                : null,
            key: line.label,
            label: line.label,
            tone: line.tone === "amber" ? "amber" : "muted",
            trying: line.trying,
          },
    [hostClient, line],
  );
  return <ConnectionPillView notice={notice} />;
}

// Clear of a navigation bar on any platform, where no header said where it ends.
const navigationBarClearance = 60;

const styles = StyleSheet.create({
  action: { justifyContent: "center", minHeight: 36, paddingRight: space[16] },
  anchor: {
    alignItems: "center",
    left: 0,
    paddingHorizontal: space[24],
    position: "absolute",
    right: 0,
  },
  label: { flexShrink: 1 },
  // An opaque capsule, like the jump pill: its words read over any transcript.
  pill: {
    ...material.float,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[8],
    maxWidth: "100%",
    minHeight: 36,
  },
  pillPressed: material.floatPressed,
  words: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: space[8],
    minHeight: 36,
    paddingLeft: space[16],
  },
  wordsAlone: { paddingRight: space[16] },
});
