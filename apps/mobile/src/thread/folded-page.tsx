import { pageSiteLabel, type HostClient, type TabDestination } from "@opensteer/client/host";
import { useRunPlaceView, type RunPlaceView } from "@opensteer/client/react";
import { useIsFocused } from "@react-navigation/native";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { agentWorkingLabel } from "../browser/acting-dot.js";
import { useSidebarVisible } from "../sidebar/sidebar-context.js";
import { space, touchTarget } from "../theme.js";
import { useAppForeground } from "../ui/foreground.js";
import { ActingRing, PlaceGlyph, PlaceSurface, pictureRadius, usePicture } from "./live-place.js";

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
  readonly onOpen: (destination: TabDestination) => void;
  readonly onUnfold: () => void;
  /** Whether the page fits above the conversation; without room the tab opens instead. */
  readonly room: boolean;
  readonly runId: string;
  readonly threadId: string;
}): ReactNode {
  const { acting, place } = useRunPlaceView(props.hostClient, props.runId, props.threadId);
  if (place === null) return null;
  return <FoldedPicture {...props} acting={acting} key={place.placeKey} place={place} />;
});

function FoldedPicture(props: {
  readonly acting: boolean;
  readonly place: RunPlaceView;
  readonly hostClient: HostClient;
  readonly onOpen: (destination: TabDestination) => void;
  readonly onUnfold: () => void;
  readonly room: boolean;
  readonly threadId: string;
}): ReactNode {
  const { acting, hostClient, place } = props;
  const destination = place.binding ?? null;
  const focused = useIsFocused();
  const sidebarVisible = useSidebarVisible();
  const foreground = useAppForeground();
  const active = focused && !sidebarVisible && foreground;
  const [picture, report] = usePicture();
  const { title, site } = place;
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
        <PlaceSurface active={active} hostClient={hostClient} onPicture={report} place={place} />
        {/* Only a picture arriving now stands for the page here. */}
        {picture.state === "live" ? null : <PlaceGlyph kind={place.kind} size={13} />}
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
    paddingHorizontal: inset,
  },
  pressed: { opacity: 0.6 },
  picture: { ...size, borderRadius: pictureRadius, overflow: "hidden" },
});
