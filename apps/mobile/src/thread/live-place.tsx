import {
  browserTabPicture,
  pageSiteLabel,
  reportRunPlacePicture,
  type HostClient,
  type RunPlacePicture,
  type RunPlacePictureReport,
} from "@opensteer/client/host";
import { useRunPlaceDisplay, type RunPlaceView } from "@opensteer/client/react";
import type { TabKind } from "@opensteer/core";
import { useCallback, useState, type ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { BrowserStream } from "../browser/browser-stream.js";
import { ComputerDisplay } from "../computers/phone-display.js";
import { macWindowVideoSupported } from "../computers/phone-display-native.js";
import { color, radius, space } from "../theme.js";
import { appear, dim, exit } from "../ui/motion.js";
import { LastPictureChip } from "../ui/last-picture-chip.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

interface SurfaceProps {
  readonly active: boolean;
  readonly place: RunPlaceView;
  readonly hostClient: HostClient;
  /**
   * Whether this view has drawn the place since it mounted. A Mac app's or
   * phone's view starts blank however long the conversation has had a picture.
   */
  readonly onPainted: (painted: boolean) => void;
  readonly threadId: string;
}

/**
 * What draws each kind of place. Each draws at the size it is laid out at, so
 * the pictures it asks for are only as large as what is drawn. None holds the
 * place's stream: the conversation's Run page holds it once, whichever form
 * shows it, so folding or unfolding never starts the picture over.
 */
const surfaces: Record<TabKind, (props: SurfaceProps) => ReactNode> = {
  page: BrowserSurface,
  window: ComputerSurface,
  phone: ComputerSurface,
  app: () => null,
};

/** Whether this binary can decode the place's picture; every binary decodes a phone's. */
export function displayCapable(place: RunPlaceView | null): boolean {
  return place?.kind !== "window" || macWindowVideoSupported();
}

/** The live picture of the place a conversation's Run is in, by the kind of place. */
export function PlaceSurface(props: SurfaceProps): ReactNode {
  const Surface = surfaces[props.place.kind];
  return <Surface {...props} />;
}

/**
 * Whether a form's own view has drawn its place: a tab's view restores the
 * picture the conversation kept as it mounts, a Mac app's or phone's only
 * once its first frame decodes.
 */
export function usePainted(place: RunPlaceView) {
  return useState(place.kind === "page");
}

function BrowserSurface(props: SurfaceProps): ReactNode {
  const { place } = props;
  const tabId = place.placeKey;
  const sessionId = place.pageSession ?? "";
  // Not drawing live (inactive behind an alert or the app switcher), it shows the kept picture.
  const kept = props.active ? null : browserTabPicture(props.hostClient, tabId);
  return kept ? (
    <Image
      accessibilityIgnoresInvertColors
      fadeDuration={0}
      source={{ uri: kept.uri }}
      style={StyleSheet.absoluteFill}
    />
  ) : (
    <BrowserStream
      active={props.active}
      hostClient={props.hostClient}
      label={props.place.title}
      preserveLastFrame
      previewSessionId={tabId}
      session={{ id: sessionId, state: "ready" }}
      sharedWatch
      tabId={tabId}
    />
  );
}

function ComputerSurface(props: SurfaceProps): ReactNode {
  const { place, hostClient, onPainted, threadId } = props;
  const sessionId = place.sessionId ?? null;
  const placeKey = place.placeKey;
  const display = useRunPlaceDisplay(hostClient, threadId, placeKey);
  const report = useCallback(
    (picture: RunPlacePictureReport) => {
      onPainted(picture.kind === "drawn");
      reportRunPlacePicture(hostClient, threadId, placeKey, picture);
    },
    [hostClient, onPainted, placeKey, threadId],
  );
  if (sessionId === null || !place.machineId) return null;
  return (
    <ComputerDisplay
      active={props.active}
      hostClient={hostClient}
      label={place.title}
      machineId={place.machineId}
      phone={place.kind === "phone"}
      preserveLastFrame
      runPlace={{ display, report }}
      source={{
        kind: "task-session",
        sessionId,
        ...(place.kind === "window" && place.appKey ? { appKey: place.appKey } : {}),
      }}
    />
  );
}

/**
 * What lies over a place's picture, the same in every form: nothing while it
 * is live, and the last picture dimmed a little while it waits for the next.
 * With no picture at all, a small form shows the place's kind; a page keeps
 * its size and names the place in it, over whatever it last drew. A form
 * whose own view has not drawn yet is covered as one with no picture.
 */
export function PictureCover(props: {
  readonly place: RunPlaceView;
  readonly painted: boolean;
  readonly picture: RunPlacePicture;
  /** The glyph's size in a small form; null for a page. */
  readonly glyph: number | null;
  /** Bumped by a tap on a stale picture: the chip acknowledges it. */
  readonly pulse?: number;
}): ReactNode {
  const { place } = props;
  const picture = props.painted ? props.picture : { ...props.picture, usable: false };
  const kind = place.kind;
  if (!picture.usable && props.glyph !== null) return <PlaceGlyph kind={kind} size={props.glyph} />;
  if (picture.usable && picture.fresh) return null;
  const site = place.site ? pageSiteLabel(place.site) : null;
  return (
    <Animated.View
      entering={picture.usable ? dim : appear}
      exiting={exit}
      pointerEvents="none"
      style={[styles.cover, picture.usable ? styles.stale : styles.waiting]}
      testID={picture.usable ? "run-page-stale" : "run-page-waiting"}
    >
      {picture.usable ? (
        props.glyph === null ? (
          <LastPictureChip pulse={props.pulse ?? 0} />
        ) : null
      ) : (
        <>
          <Symbol name={placeSymbol(kind)} size={24} tint={color.muted} />
          <AppText numberOfLines={1} role="secondaryMedium" style={styles.coverTitle}>
            {place.title}
          </AppText>
          {site && site !== place.title ? (
            <AppText numberOfLines={1} role="caption" tone="muted">
              {site}
            </AppText>
          ) : null}
        </>
      )}
    </Animated.View>
  );
}

/** How a picture is described while it shows the place as it last was. */
export function pictureWords(picture: RunPlacePicture): string {
  return picture.usable && !picture.fresh ? ", last picture" : "";
}

/** Whether this conversation's agent acts in its Run's place right now. */
/** What stands for a place with no picture to show: its kind, never an empty frame. */
export function PlaceGlyph(props: { readonly kind: TabKind; readonly size: number }): ReactNode {
  return (
    <View pointerEvents="none" style={styles.glyph}>
      <Symbol name={placeSymbol(props.kind)} size={props.size} tint={color.muted} />
    </View>
  );
}

function placeSymbol(kind: TabKind) {
  return kind === "page"
    ? "globe"
    : kind === "phone"
      ? "smartphone"
      : kind === "app"
        ? "square.grid.2x2"
        : "laptopcomputer";
}

/** Green says an agent is acting here, as everywhere else in the app. */
export function ActingRing(props: { readonly radius: number }): ReactNode {
  return <View pointerEvents="none" style={[styles.ring, { borderRadius: props.radius }]} />;
}

const styles = StyleSheet.create({
  glyph: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    justifyContent: "center",
  },
  cover: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    gap: space[4],
    justifyContent: "center",
    paddingHorizontal: space[24],
  },
  // Enough to read as "not now" on a bright page, never enough to hide it.
  stale: { backgroundColor: "rgba(8, 8, 8, 0.3)" },
  // Over a page it last drew, or the empty stage: the place, named, waiting.
  waiting: { backgroundColor: "rgba(8, 8, 8, 0.72)" },
  coverTitle: { marginTop: space[6], maxWidth: "100%" },
  ring: {
    ...StyleSheet.absoluteFill,
    borderColor: color.green,
    borderWidth: 1.5,
  },
});

export const pictureRadius = radius.xs;
