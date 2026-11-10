import { pageSiteLabel, type HostClient, type SurfaceDestination } from "@opensteer/client/host";
import { useRunPlace, useRunPlaceBinding } from "@opensteer/client/react";
import type { PlaceEnteredEventView } from "@opensteer/core";
import { placeIdentityKey } from "@opensteer/protocol";
import { useIsFocused } from "@react-navigation/native";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { agentWorkingLabel } from "../browser/acting-dot.js";
import { useSidebarVisible } from "../sidebar/sidebar-context.js";
import { space, touchTarget } from "../theme.js";
import { useAppForeground } from "../ui/foreground.js";
import {
  ActingRing,
  PlaceGlyph,
  PlaceSurface,
  pictureRadius,
  usePicture,
  useRunPlaceActing,
} from "./live-place.js";

/** Small enough to sit in the bar, so it asks for a small picture. */
const size = { height: 24, width: 38 } as const;

/**
 * A conversation's Run page, folded into the bar beside Around: a small live
 * picture of the place. Tapping it opens the page above the conversation, or
 * the full tab where there is no room for the page.
 */
export const FoldedPage = memo(function FoldedPage(props: {
  readonly hostClient: HostClient;
  readonly onOpen: (destination: SurfaceDestination) => void;
  readonly onUnfold: () => void;
  /** Whether the page fits above the conversation; without room the tab opens instead. */
  readonly room: boolean;
  readonly runId: string;
  readonly threadId: string;
}): ReactNode {
  const entry = useRunPlace(props.hostClient, props.runId);
  if (entry === null) return null;
  return <FoldedPicture {...props} key={placeIdentityKey(entry.data.place)} entry={entry} />;
});

function FoldedPicture(props: {
  readonly entry: PlaceEnteredEventView;
  readonly hostClient: HostClient;
  readonly onOpen: (destination: SurfaceDestination) => void;
  readonly onUnfold: () => void;
  readonly room: boolean;
  readonly threadId: string;
}): ReactNode {
  const { entry, hostClient } = props;
  const { destination, sessionId } = useRunPlaceBinding(hostClient, entry);
  const focused = useIsFocused();
  const sidebarVisible = useSidebarVisible();
  const foreground = useAppForeground();
  const active = focused && !sidebarVisible && foreground;
  const [picture, report] = usePicture();
  const acting = useRunPlaceActing(hostClient, entry, props.threadId);
  const { title, site } = entry.data;
  const siteLabel = site ? pageSiteLabel(site) : null;
  return (
    <Pressable
      accessibilityHint={props.room ? "Shows the page above the conversation" : "Opens the page"}
      accessibilityLabel={`${title}${siteLabel && siteLabel !== title ? `, ${siteLabel}` : ""}${acting ? `, ${agentWorkingLabel}` : ""}`}
      accessibilityRole="button"
      disabled={!props.room && destination === null}
      onPress={() => {
        if (props.room) props.onUnfold();
        else if (destination) props.onOpen(destination);
      }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID="folded-page"
    >
      <View pointerEvents="none" style={styles.picture}>
        <PlaceSurface
          active={active}
          destination={destination}
          entry={entry}
          hostClient={hostClient}
          onPicture={report}
          sessionId={sessionId}
        />
        {/* Only a picture arriving now stands for the page here. */}
        {picture.state === "live" ? null : <PlaceGlyph kind={entry.data.place.kind} size={13} />}
        {acting ? <ActingRing radius={pictureRadius} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[4],
  },
  pressed: { opacity: 0.6 },
  picture: { ...size, borderRadius: pictureRadius, overflow: "hidden" },
});
