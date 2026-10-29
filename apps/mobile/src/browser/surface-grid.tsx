import { profileBadgesVisible, type HostClient } from "@opensteer/client/host";
import { memo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaFrame } from "react-native-safe-area-context";
import { AppMark } from "../computers/app-mark.js";
import { MacAppPreview } from "../computers/mac-app-view.js";
import { color, radius, space } from "../theme.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { agentWorkingLabel } from "./acting-dot.js";
import { BrowserStream } from "./browser-stream.js";
import type { TabTile } from "./tab-tiles.js";

/**
 * Every tile's picture has this one shape, whatever the page's own: a grid
 * whose rows change height as pictures arrive reflows under the reader's
 * thumb, and two columns only line up when every tile is the same.
 */
const pictureAspect = 4 / 3;
/** The narrowest tile whose title and site still read, at the reader's text size. */
const tileMinimumWidth = 150;
const gridPadding = space[16];
const columnGap = space[16];

/**
 * How many tiles share a row in a pane this wide: two on an ordinary phone,
 * one on a narrow pane or with larger text, more on a tablet. Measured from
 * the pane, never the device.
 */
export function tileColumns(paneWidth: number, fontScale: number): number {
  const minimum = tileMinimumWidth * Math.min(2, Math.max(1, fontScale));
  const room = paneWidth - gridPadding * 2;
  return Math.max(1, Math.min(4, Math.floor((room + columnGap) / (minimum + columnGap))));
}

/**
 * A grid of tabs, apps and phones, one tile each, in the order given. Only
 * tiles on screen take pictures, and a saved tab takes none. An agent acting
 * in one rings it green; nothing else is said over a picture.
 */
export function SurfaceGrid(props: {
  /** In front of the reader, connected, with the app in the foreground. */
  readonly active: boolean;
  readonly header?: ReactNode;
  readonly hostClient: HostClient;
  /** Nothing is known yet. */
  readonly loading: boolean;
  readonly onOpen: (tile: TabTile) => void;
  readonly tiles: readonly TabTile[];
  /** What an empty grid says it will hold. */
  readonly emptyDetail: string;
}): ReactNode {
  // The pane's width, not the window's: beside a docked sidebar the grid has
  // only what it is drawn in.
  const { width } = useSafeAreaFrame();
  const { fontScale } = useWindowDimensions();
  const insets = useContentInsets();
  const paneWidth = width - insets.left - insets.right;
  const columns = tileColumns(paneWidth, fontScale);
  // A last row with fewer tiles keeps the others' width rather than stretching.
  const cellWidth = (paneWidth - gridPadding * 2 - columnGap * (columns - 1)) / columns;
  const showProfiles = profileBadgesVisible(props.tiles);
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const onVisible = useRef(({ viewableItems }: { viewableItems: readonly { item: TabTile }[] }) =>
    setVisible(new Set(viewableItems.map(({ item }) => item.key))),
  );
  const viewability = useRef({ itemVisiblePercentThreshold: 30 });
  return (
    <FlatList
      // A list cannot change its column count in place.
      key={columns}
      {...(columns > 1 ? { columnWrapperStyle: styles.columns } : {})}
      contentContainerStyle={[
        styles.grid,
        { paddingLeft: gridPadding + insets.left, paddingRight: gridPadding + insets.right },
      ]}
      contentInsetAdjustmentBehavior="automatic"
      data={props.tiles}
      keyExtractor={(item) => item.key}
      ListEmptyComponent={
        <View style={styles.empty}>
          <AppText role="bodyMedium" tone={props.loading ? "muted" : "default"}>
            {props.loading ? "Finding tabs…" : "No tabs yet"}
          </AppText>
          {props.loading ? null : (
            <AppText role="secondary" style={styles.centred} tone="muted">
              {props.emptyDetail}
            </AppText>
          )}
        </View>
      }
      ListHeaderComponent={props.header === undefined ? undefined : <>{props.header}</>}
      numColumns={columns}
      onViewableItemsChanged={onVisible.current}
      renderItem={({ item }) => (
        <View style={[styles.cell, columns > 1 && { maxWidth: cellWidth }]}>
          <Tile
            active={props.active && visible.has(item.key)}
            hostClient={props.hostClient}
            onOpen={props.onOpen}
            showProfile={showProfiles}
            tile={item}
          />
        </View>
      )}
      viewabilityConfig={viewability.current}
      windowSize={3}
    />
  );
}

/** What a tile says to a screen reader: what it is, then anything that is not ordinary. */
export function tileLabel(tile: TabTile, showProfile: boolean): string {
  return [
    tile.title,
    tile.site,
    tile.kind === "browser" && showProfile ? (tile.identity?.name ?? null) : null,
    tile.acting ? agentWorkingLabel.toLowerCase() : null,
    tile.state === "opening" ? "opening" : null,
    tile.state === "unavailable" ? tile.reason : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
}

/**
 * One tile: the picture at the grid's one shape, then the title with the site,
 * or the app with its Mac, under it.
 */
const Tile = memo(function Tile(props: {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly tile: TabTile;
  readonly showProfile: boolean;
  readonly onOpen: (tile: TabTile) => void;
}): ReactNode {
  const { tile } = props;
  const label = tileLabel(tile, props.showProfile);
  const { picture } = tile;
  return (
    <Pressable
      accessibilityHint={tile.kind === "browser" ? "Opens this tab" : "Opens this app"}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={() => props.onOpen(tile)}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
      testID={`tile:${tile.state}:${tile.acting ? "acting" : "idle"}`}
    >
      {/* The light sits outside the clip that rounds the picture, or it would be cut away. */}
      <View
        pointerEvents="none"
        style={[{ aspectRatio: pictureAspect }, tile.acting && styles.glow]}
        testID="tile-picture"
      >
        <View
          style={[
            styles.preview,
            tile.acting ? styles.acting : styles.idle,
            tile.state === "unavailable" && styles.dimmed,
          ]}
        >
          {picture?.kind === "browser" ? (
            <BrowserStream
              active={props.active}
              hostClient={props.hostClient}
              label={label}
              session={picture.session}
              tabId={picture.tabId}
            />
          ) : picture?.kind === "native" ? (
            <MacAppPreview
              active={props.active}
              appName={tile.title}
              hostClient={props.hostClient}
              label={label}
              machineId={picture.machineId}
              phone={picture.phone}
              source={picture.source}
            />
          ) : (
            <View style={styles.placeholder}>
              {tile.state === "opening" ? (
                <ActivityIndicator color={color.muted} />
              ) : (
                <Symbol
                  name={
                    tile.kind === "browser"
                      ? "globe"
                      : tile.kind === "phone"
                        ? "smartphone"
                        : "laptopcomputer"
                  }
                  size={22}
                  tint={color.mutedDim}
                />
              )}
            </View>
          )}
        </View>
      </View>
      <View style={styles.caption}>
        <View style={styles.line}>
          {tile.kind === "browser" ? (
            <Symbol name="globe" size={13} tint={color.textSoft} />
          ) : tile.kind === "phone" ? (
            <Symbol name="smartphone" size={16} tint={color.textSoft} />
          ) : (
            <AppMark name={tile.title} size={16} />
          )}
          <AppText numberOfLines={1} role="secondaryMedium" style={styles.shrink}>
            {tile.title}
          </AppText>
        </View>
        {(tile.site === null || tile.site === "") &&
        !(tile.kind === "browser" && props.showProfile) ? null : (
          <View style={styles.line}>
            {tile.kind === "app" ? (
              <Symbol name="laptopcomputer" size={11} tint={color.muted} />
            ) : null}
            <AppText numberOfLines={1} role="caption" style={styles.shrink} tone="muted">
              {tile.site}
            </AppText>
            {tile.kind === "browser" && props.showProfile && tile.identity !== null ? (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.profile,
                  tile.identity.kind === "guest"
                    ? styles.guest
                    : { backgroundColor: tile.identity.tint },
                ]}
              >
                {tile.identity.kind === "profile" ? (
                  <AppText role="caption" style={styles.initial}>
                    {tile.identity.initial}
                  </AppText>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // An agent at work: a green ring and its soft light. Nothing else is green.
  acting: { borderColor: color.green, borderWidth: 2 },
  caption: { gap: space[2], paddingHorizontal: space[4] },
  cell: { flex: 1 },
  centred: { textAlign: "center" },
  columns: { gap: columnGap },
  dimmed: { opacity: 0.35 },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[24],
    paddingTop: space[64],
  },
  glow: {
    backgroundColor: color.surfaceCode,
    borderRadius: radius.md,
    shadowColor: color.green,
    shadowOffset: { height: 0, width: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
  },
  grid: { gap: space[20], padding: gridPadding },
  idle: { borderColor: color.line, borderWidth: StyleSheet.hairlineWidth },
  line: { alignItems: "center", flexDirection: "row", gap: space[6] },
  placeholder: { alignItems: "center", flex: 1, justifyContent: "center" },
  pressed: { opacity: 0.7 },
  preview: {
    backgroundColor: color.surfaceCode,
    borderRadius: radius.md,
    flex: 1,
    overflow: "hidden",
  },
  profile: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 18,
    minWidth: 18,
    borderRadius: radius.full,
  },
  guest: { borderColor: color.muted, borderWidth: 1, borderStyle: "dashed" },
  initial: { color: color.text, paddingHorizontal: space[4] },
  shrink: { flexShrink: 1 },
  tile: { gap: space[8], minHeight: 44 },
});
