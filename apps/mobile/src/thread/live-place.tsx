import { pageSiteLabel, type HostClient } from "@opensteer/client/host";
import { useHostSelector, useRunPlace, useRunPlaceBinding } from "@opensteer/client/react";
import { useNavigationState } from "@react-navigation/native";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { placeIdentityKey } from "@opensteer/protocol";
import { BrowserStream } from "../browser/browser-stream.js";
import { paramsDestination, sameDestination } from "../browser/surface-route.js";
import { ComputerDisplay } from "../computers/phone-display.js";
import { color, material, radius, space } from "../theme.js";
import { useAppForeground } from "../ui/foreground.js";
import { appear, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import type { SurfaceDestination } from "@opensteer/client/host";

/** The Run owns the card; independent inventories only supply its picture binding. */
export const LivePlace = memo(function LivePlace(props: {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly onOpen: (destination: SurfaceDestination) => void;
  readonly runId: string;
}) {
  const { hostClient } = props;
  const entry = useRunPlace(hostClient, props.runId);
  const { destination, sessionId } = useRunPlaceBinding(hostClient, entry);
  const authorized = useHostSelector(
    hostClient,
    (snapshot) => snapshot.session === "authenticated" && snapshot.user !== null,
  );
  const foreground = useAppForeground();
  const current = useNavigationState((state) => state.routes[state.index]);
  if (entry === null || !authorized) return null;
  if (
    current?.name === "WorkspaceBrowser" &&
    destination !== null &&
    sameDestination(paramsDestination(current.params), destination)
  )
    return null;
  const { place, title, site } = entry.data;
  const active = props.active && foreground;
  const siteLabel = site ? pageSiteLabel(site) : null;
  return (
    <Animated.View entering={appear} exiting={exit}>
      <Pressable
        accessibilityLabel={`Open ${title}`}
        accessibilityRole="button"
        disabled={destination === null}
        onPress={() => {
          if (destination) props.onOpen(destination);
        }}
        style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        testID="live-place"
      >
        <View pointerEvents="none" style={styles.picture}>
          {place.kind === "browser" ? (
            <BrowserStream
              key={place.surfaceId}
              active={active}
              hostClient={hostClient}
              label={title}
              preserveLastFrame
              previewSessionId={place.sessionId}
              session={{
                id: destination?.kind === "browser" ? destination.sessionId : place.sessionId,
                state: "ready",
              }}
              tabId={place.surfaceId}
            />
          ) : sessionId !== null ? (
            <ComputerDisplay
              key={placeIdentityKey(place)}
              active={active}
              preserveLastFrame
              hostClient={hostClient}
              label={title}
              machineId={place.machineId}
              phone={place.kind === "phone"}
              source={{
                kind: "task-session",
                sessionId,
                ...(place.kind === "app" ? { appKey: place.appKey } : {}),
              }}
            />
          ) : (
            <Symbol
              name={place.kind === "phone" ? "smartphone" : "laptopcomputer"}
              size={22}
              tint={color.muted}
            />
          )}
        </View>
        <View style={styles.words}>
          <AppText numberOfLines={1} role="secondaryMedium">
            {title}
          </AppText>
          {siteLabel && siteLabel !== title ? (
            <AppText numberOfLines={1} role="caption" tone="muted">
              {siteLabel}
            </AppText>
          ) : null}
        </View>
        <Symbol name="chevron.right" size={12} tint={color.muted} />
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  card: {
    ...material.control,
    height: 64,
    width: "100%",
    maxWidth: 384,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space[10],
    padding: space[4],
    paddingRight: space[12],
    overflow: "hidden",
  },
  pressed: { backgroundColor: color.surfacePressed },
  picture: {
    width: 88,
    height: 54,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: color.surfaceCode,
    alignItems: "center",
    justifyContent: "center",
  },
  words: { flex: 1, minWidth: 0, gap: space[2] },
});
