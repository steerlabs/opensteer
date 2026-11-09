import { runPlaceActing, type HostClient, type SurfaceDestination } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { PlaceEnteredEventView } from "@opensteer/core";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
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
  readonly destination: SurfaceDestination | null;
  readonly entry: PlaceEnteredEventView;
  readonly hostClient: HostClient;
  readonly onPageSize?: (size: { readonly height: number; readonly width: number }) => void;
  readonly onPicture: (state: PictureState) => void;
  /** The Run's session in a Mac app or phone. */
  readonly sessionId: string | null;
}

/**
 * What draws each kind of place. Each draws at the size it is laid out at, so
 * the pictures it asks for are only as large as what is drawn. Every one is
 * watch-only today; a tab that runs on this phone will bring its own here.
 */
const surfaces: Record<
  PlaceEnteredEventView["data"]["place"]["kind"],
  (props: SurfaceProps) => ReactNode
> = { browser: BrowserSurface, app: ComputerSurface, phone: ComputerSurface };

/** The live picture of the place a conversation's Run is in, by the kind of place. */
export function PlaceSurface(props: SurfaceProps): ReactNode {
  const Surface = surfaces[props.entry.data.place.kind];
  return <Surface {...props} />;
}

function BrowserSurface(props: SurfaceProps): ReactNode {
  const { active, destination, hostClient, onPicture } = props;
  const place = props.entry.data.place;
  const tabId = place.kind === "browser" ? place.surfaceId : "";
  const sessionId =
    destination?.kind === "browser"
      ? destination.sessionId
      : place.kind === "browser"
        ? place.sessionId
        : "";
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
    if (!active) return;
    onPicture(
      feed.error !== null || feed.status === "unavailable"
        ? "none"
        : feed.status === "live" && drawn
          ? "live"
          : "waiting",
    );
  }, [active, drawn, feed.error, feed.status, onPicture]);
  return (
    <BrowserStream
      active={active}
      hostClient={hostClient}
      label={props.entry.data.title}
      onPageSize={sized}
      preserveLastFrame
      previewSessionId={place.kind === "browser" ? place.sessionId : sessionId}
      session={{ id: sessionId, state: "ready" }}
      tabId={tabId}
    />
  );
}

function ComputerSurface(props: SurfaceProps): ReactNode {
  const { onPicture, sessionId } = props;
  const place = props.entry.data.place;
  const shown = useCallback(
    (picture: boolean) => onPicture(picture ? "live" : "none"),
    [onPicture],
  );
  useEffect(() => {
    if (sessionId === null) onPicture("none");
  }, [onPicture, sessionId]);
  if (sessionId === null || place.kind === "browser") return null;
  return (
    <ComputerDisplay
      active={props.active}
      hostClient={props.hostClient}
      label={props.entry.data.title}
      machineId={place.machineId}
      onPageSize={props.onPageSize}
      onShown={shown}
      phone={place.kind === "phone"}
      preserveLastFrame
      source={{
        kind: "task-session",
        sessionId,
        ...(place.kind === "app" ? { appKey: place.appKey } : {}),
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

/** Whether this conversation's agent acts in its Run's place right now. */
export function useRunPlaceActing(
  hostClient: HostClient,
  entry: PlaceEnteredEventView | null,
  threadId: string,
): boolean {
  return useHostSelector(hostClient, (snapshot) =>
    entry === null ? false : runPlaceActing(entry, snapshot, threadId),
  );
}

/** What stands for a place with no picture to show: its kind, never an empty frame. */
export function PlaceGlyph(props: {
  readonly kind: PlaceEnteredEventView["data"]["place"]["kind"];
  readonly size: number;
}): ReactNode {
  return (
    <View pointerEvents="none" style={styles.glyph}>
      <Symbol
        name={
          props.kind === "browser"
            ? "globe"
            : props.kind === "phone"
              ? "smartphone"
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
