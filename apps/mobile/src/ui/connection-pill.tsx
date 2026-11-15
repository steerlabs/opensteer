import {
  describeHostConnection,
  type HostClient,
  type HostConnectionLine,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useEffect, type ReactNode } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { material, radius, space } from "../theme.js";
import { useSelectedHostClient } from "./mobile-client-context.js";
import { descend, exit, move } from "./motion.js";
import { AppText, StatusDot } from "./primitives.js";

type ConnectionNotice = HostConnectionLine & { readonly trying: boolean };

const selectNotice = (snapshot: HostSnapshot): ConnectionNotice | null =>
  snapshot.connectionInterrupted
    ? { ...describeHostConnection(snapshot), trying: snapshot.connection === "connecting" }
    : null;

const sameNotice = (left: ConnectionNotice | null, right: ConnectionNotice | null): boolean =>
  left?.label === right?.label && left?.trying === right?.trying;

/**
 * Where an interrupted connection is said, once, for the whole app. It floats
 * over every screen instead of sitting in one, so nothing moves under a reader
 * when it comes or goes, and it stays away until the Host client says the
 * interruption has lasted.
 */
export function ConnectionPill(): ReactNode {
  const hostClient = useSelectedHostClient();
  return hostClient === null ? null : <HostConnectionPill hostClient={hostClient} />;
}

function HostConnectionPill(props: { readonly hostClient: HostClient }): ReactNode {
  const { hostClient } = props;
  const notice = useHostSelector(hostClient, selectNotice, sameNotice);
  const top = useSafeAreaInsets().top + navigationBarClearance;
  const label = notice?.label ?? null;
  useEffect(() => {
    if (label !== null) void AccessibilityInfo.announceForAccessibility(label);
  }, [label]);
  return (
    <View pointerEvents="box-none" style={[styles.anchor, { top }]}>
      {notice === null ? null : (
        <Animated.View
          entering={descend}
          exiting={exit}
          layout={move}
          pointerEvents={notice.action === "retry" ? "auto" : "none"}
          style={styles.pill}
        >
          <StatusDot live={notice.trying} tone={notice.tone} />
          <AppText numberOfLines={1} role="secondaryMedium" tone="soft">
            {notice.label}
          </AppText>
          {notice.action === "retry" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry connecting"
              hitSlop={space[12]}
              onPress={() =>
                void hostClient.refresh({ retryConnection: true }).catch(() => undefined)
              }
            >
              <AppText role="secondaryMedium" tone="ember">
                Retry
              </AppText>
            </Pressable>
          ) : null}
        </Animated.View>
      )}
    </View>
  );
}

// Clear of a navigation bar on any platform: the root sits outside the
// navigator, so it cannot measure one.
const navigationBarClearance = 60;

const styles = StyleSheet.create({
  anchor: { alignItems: "center", left: 0, position: "absolute", right: 0 },
  // An opaque capsule, like the jump pill: its words read over any transcript.
  pill: {
    ...material.float,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[8],
    minHeight: 36,
    paddingHorizontal: space[16],
  },
});
