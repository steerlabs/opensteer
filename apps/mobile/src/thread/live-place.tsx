import { browserTabPicture, type HostClient } from "@opensteer/client/host";
import type { RunPlaceView } from "@opensteer/client/react";
import type { TabKind } from "@opensteer/core";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { BrowserStream, useBrowserFeedState } from "../browser/browser-stream.js";
import { ComputerDisplay } from "../computers/phone-display.js";
import { color, radius } from "../theme.js";
import { Symbol } from "../ui/symbol.js";

/**
 * Whether a place's picture is live: a picture arriving now, still waiting for
 * the next, or none to be had, such as a tab still restoring, a closed place,
 * an offline computer or no picture credit.
 */
export type PictureState = "live" | "waiting" | "none";

interface SurfaceProps {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly onPageSize?: (size: { readonly height: number; readonly width: number }) => void;
  readonly onPicture: (state: PictureState) => void;
  /** The Run's place: its tab, this device's page session, or the Run's own native session. */
  readonly place: RunPlaceView;
}

/**
 * What draws each kind of place. Each draws at the size it is laid out at, so
 * the pictures it asks for are only as large as what is drawn. Every one is
 * watch-only today; a tab that runs on this phone will bring its own here.
 */
const surfaces: Record<TabKind, (props: SurfaceProps) => ReactNode> = {
  page: BrowserSurface,
  window: ComputerSurface,
  phone: ComputerSurface,
  app: NoSurface,
};

/** The live picture of the place a conversation's Run is in, by the kind of place. */
export function PlaceSurface(props: SurfaceProps): ReactNode {
  const Surface = surfaces[props.place.kind];
  return <Surface {...props} />;
}

/** An app has no live picture here; its tab shows it. */
function NoSurface(props: SurfaceProps): ReactNode {
  const { onPicture } = props;
  useEffect(() => onPicture("none"), [onPicture]);
  return null;
}

function BrowserSurface(props: SurfaceProps): ReactNode {
  const { active, hostClient, onPicture, place } = props;
  const tabId = place.placeKey;
  // The page is watched through this device's own binding of its tab.
  const sessionId = place.pageSession ?? "";
  const feed = useBrowserFeedState(hostClient, sessionId, tabId, false);
  // A feed can be live before anything is drawn; only a drawn picture reports a size.
  const [drawn, setDrawn] = useState(false);
  const { onPageSize } = props;
  const sized = useCallback(
    (size: { readonly height: number; readonly width: number }) => {
      setDrawn(true);
      onPageSize?.(size);
    },
    [onPageSize],
  );
  useEffect(() => {
    // A stream that is not watched draws nothing, so its picture is not live.
    if (!active) setDrawn(false);
    onPicture(
      !active
        ? "waiting"
        : feed.error !== null || feed.status === "unavailable"
          ? "none"
          : feed.status === "live" && drawn
            ? "live"
            : "waiting",
    );
  }, [active, drawn, feed.error, feed.status, onPicture]);
  const kept = active ? null : browserTabPicture(hostClient, tabId);
  return (
    <>
      {kept ? (
        <Image
          accessibilityIgnoresInvertColors
          fadeDuration={0}
          source={{ uri: kept.uri }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <BrowserStream
        active={active}
        hostClient={hostClient}
        label={place.title}
        onPageSize={sized}
        preserveLastFrame
        previewSessionId={tabId}
        session={{ id: sessionId, state: "ready" }}
        tabId={tabId}
      />
    </>
  );
}

function ComputerSurface(props: SurfaceProps): ReactNode {
  const { onPicture, place } = props;
  const sessionId = place.sessionId ?? null;
  const machineId = place.machineId ?? null;
  const shown = useCallback(
    (picture: boolean) => onPicture(picture ? "live" : "none"),
    [onPicture],
  );
  useEffect(() => {
    if (sessionId === null) onPicture("none");
  }, [onPicture, sessionId]);
  if (sessionId === null || machineId === null) return null;
  return (
    <ComputerDisplay
      active={props.active}
      hostClient={props.hostClient}
      label={place.title}
      machineId={machineId}
      onPageSize={props.onPageSize}
      onShown={shown}
      phone={place.kind === "phone"}
      preserveLastFrame
      source={{
        kind: "task-session",
        sessionId,
        ...(place.kind === "window" && place.appKey ? { appKey: place.appKey } : {}),
      }}
    />
  );
}

/**
 * Whether the picture may stand for the place now. Until it has been live it
 * may not: a picture kept from earlier never stands for the page as it is.
 * Once live, a moment's wait keeps it; a place with no picture to give drops it.
 * Hold one per place: key its owner by the place.
 */
export function usePicture(): readonly [
  { readonly state: PictureState; readonly seen: boolean },
  (state: PictureState) => void,
] {
  const [value, setValue] = useState({ state: "none" as PictureState, seen: false });
  const report = useCallback(
    (state: PictureState) =>
      setValue((current) => {
        const seen = state === "live" || (state === "waiting" && current.seen);
        return current.state === state && current.seen === seen ? current : { state, seen };
      }),
    [],
  );
  return [value, report] as const;
}

/** What stands for a place with no picture to show: its kind, never an empty frame. */
export function PlaceGlyph(props: { readonly kind: TabKind; readonly size: number }): ReactNode {
  return (
    <View pointerEvents="none" style={styles.glyph}>
      <Symbol
        name={
          props.kind === "page"
            ? "globe"
            : props.kind === "phone"
              ? "smartphone"
              : props.kind === "app"
                ? "square.grid.2x2"
                : "laptopcomputer"
        }
        size={props.size}
        tint={color.muted}
      />
    </View>
  );
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
  ring: {
    ...StyleSheet.absoluteFill,
    borderColor: color.green,
    borderWidth: 1.5,
  },
});

export const pictureRadius = radius.xs;
