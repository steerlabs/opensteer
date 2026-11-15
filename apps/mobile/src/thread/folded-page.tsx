import { pageSiteLabel, type HostClient, type SurfaceDestination } from "@opensteer/client/host";
import { useRunPageView, useRunPlace, useRunPlaceBinding } from "@opensteer/client/react";
import type { PlaceEnteredEventView } from "@opensteer/core";
import { placeIdentityKey } from "@opensteer/protocol";
import { useIsFocused } from "@react-navigation/native";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { agentWorkingLabel } from "../browser/acting-dot.js";
import { useSidebarVisible } from "../sidebar/sidebar-context.js";
import { space, touchTarget } from "../theme.js";
import { useAppForeground } from "../ui/foreground.js";
import { appear } from "../ui/motion.js";
import {
  ActingRing,
  PictureCover,
  PlaceSurface,
  pictureRadius,
  pictureWords,
  usePainted,
  useRunPlaceActing,
} from "./live-place.js";

/** Small enough to sit in the bar, so it asks for a small picture. */
const size = { height: 24, width: 38 } as const;
const inset = space[4];

/** What the folded page takes in the bar. */
export const foldedPageWidth = size.width + 2 * inset;

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
  const { entry, hostClient, threadId } = props;
  const { destination, sessionId } = useRunPlaceBinding(hostClient, entry);
  const focused = useIsFocused();
  const sidebarVisible = useSidebarVisible();
  const foreground = useAppForeground();
  const active = focused && !sidebarVisible && foreground;
  // The picture the page itself would show: the conversation's pane holds it.
  const [{ picture }] = useRunPageView(hostClient, threadId);
  const acting = useRunPlaceActing(hostClient, entry, threadId);
  const [painted, setPainted] = usePainted(entry);
  const { title, site } = entry.data;
  const siteLabel = site ? pageSiteLabel(site) : null;
  return (
    <Pressable
      accessibilityHint={props.room ? "Shows the page above the conversation" : "Opens the page"}
      accessibilityLabel={`${title}${siteLabel && siteLabel !== title ? `, ${siteLabel}` : ""}${acting ? `, ${agentWorkingLabel}` : ""}${pictureWords(picture)}`}
      accessibilityRole="button"
      disabled={!props.room && destination === null}
      onPress={() => {
        if (props.room) props.onUnfold();
        else if (destination) props.onOpen(destination);
      }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID="folded-page"
    >
      <Animated.View entering={appear} pointerEvents="none" style={styles.picture}>
        <PlaceSurface
          active={active}
          destination={destination}
          entry={entry}
          hostClient={hostClient}
          onPainted={setPainted}
          sessionId={sessionId}
          threadId={threadId}
        />
        <PictureCover entry={entry} glyph={13} painted={painted} picture={picture} />
        {acting ? <ActingRing radius={pictureRadius} /> : null}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: inset,
  },
  pressed: { opacity: 0.6 },
  picture: { ...size, borderRadius: pictureRadius, overflow: "hidden" },
});
