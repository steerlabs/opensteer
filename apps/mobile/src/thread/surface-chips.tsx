import {
  messagePages,
  replyPlaces,
  type HostClient,
  type HostSnapshot,
  type SurfaceDestination,
  type Turn,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { BrowserPageContentPart } from "@opensteer/core";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { color, material, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { agentWorkingLabel } from "../browser/acting-dot.js";
import { AppMark } from "../computers/app-mark.js";

/**
 * How transcript rows reach the pages and apps they name. Rows are memoized
 * on their entries, and a browser opens, changes title and ends without
 * touching one, so the chips read the Host's browsers from here.
 */
export interface TranscriptSurfaces {
  readonly hostClient: HostClient;
  /** Each stretch's turn key finds the gathered work of its owning reply. */
  readonly turns?: ReadonlyMap<string, SurfaceTurn>;
  /** Opens exactly this page or app; nothing stands in for one that has gone. */
  readonly open: (destination: SurfaceDestination) => void;
}

export const TranscriptSurfacesContext = createContext<TranscriptSurfaces | null>(null);

/** A reply shows this many pages before the rest fold behind "+N". */
const shownChips = 3;

/**
 * The page a person included with their message, above its words: the page
 * as they saw it, which opens that exact tab while its browser is open.
 */
export function MessagePages(props: {
  readonly pages: readonly BrowserPageContentPart[];
}): ReactNode {
  const surfaces = useContext(TranscriptSurfacesContext);
  if (surfaces === null || props.pages.length === 0) return null;
  return <IncludedPages pages={props.pages} surfaces={surfaces} />;
}

function IncludedPages(props: {
  readonly pages: readonly BrowserPageContentPart[];
  readonly surfaces: TranscriptSurfaces;
}): ReactNode {
  const sessions = useHostSelector(props.surfaces.hostClient, selectBrowserSessions);
  return (
    <View style={styles.pages}>
      {messagePages(props.pages, sessions).map((page) => (
        <SurfaceChip
          ended={page.ended}
          favicon={page.favicon}
          glyph="globe"
          key={page.key}
          onPress={() => props.surfaces.open(page.destination)}
          secondary={page.site}
          title={page.title}
        />
      ))}
    </View>
  );
}

/**
 * The pages its Run used and apps and phones its steps used, under the reply.
 * Three show; the rest fold behind "+N", which opens them in place.
 */
type SurfaceTurn = Pick<Turn, "runId" | "subagentWork" | "work">;

export function ReplySurfaces(props: {
  readonly turn: SurfaceTurn;
  readonly turnKey?: string | null;
}): ReactNode {
  const surfaces = useContext(TranscriptSurfacesContext);
  if (surfaces === null || props.turn.runId === null) return null;
  return <RunSurfaces turn={props.turn} turnKey={props.turnKey ?? null} surfaces={surfaces} />;
}

function RunSurfaces(props: {
  readonly turn: SurfaceTurn;
  readonly turnKey: string | null;
  readonly surfaces: TranscriptSurfaces;
}): ReactNode {
  const { surfaces } = props;
  const turn = surfaces.turns?.get(props.turnKey ?? "") ?? props.turn;
  const sessions = useHostSelector(surfaces.hostClient, selectBrowserSessions);
  const machines = useHostSelector(surfaces.hostClient, selectMachines);
  const connection = useHostSelector(surfaces.hostClient, selectConnection);
  const [open, setOpen] = useState(false);
  const chips = useMemo(
    (): readonly Chip[] =>
      replyPlaces(turn, sessions, connection === "connected" ? machines : []).map((place): Chip =>
        place.kind === "page"
          ? {
              acting: place.page.acting,
              destination: place.page.destination,
              ended: place.page.ended,
              favicon: place.page.favicon,
              glyph: "globe",
              key: place.page.key,
              secondary: place.page.site,
              title: place.page.title,
            }
          : place.kind === "phone"
            ? {
                acting: false,
                destination: place.phone.destination,
                ended: place.phone.ended,
                favicon: null,
                glyph: "smartphone",
                key: place.phone.key,
                secondary: null,
                title: place.phone.title,
              }
            : {
                acting: place.app.acting,
                destination: place.app.destination,
                ended: place.app.ended,
                favicon: null,
                glyph: "laptopcomputer",
                key: place.app.key,
                secondary: null,
                title: place.app.title,
              },
      ),
    [connection, machines, turn, sessions],
  );
  if (chips.length === 0) return null;
  const shown = open ? chips : chips.slice(0, shownChips);
  const folded = chips.length - shown.length;
  return (
    <View style={styles.reply}>
      {shown.map((chip) => (
        <SurfaceChip
          acting={chip.acting}
          ended={chip.ended}
          favicon={chip.favicon}
          glyph={chip.glyph}
          key={chip.key}
          onPress={() => {
            if (chip.destination) surfaces.open(chip.destination);
          }}
          secondary={chip.secondary}
          title={chip.title}
        />
      ))}
      {folded > 0 ? (
        <Pressable
          accessibilityLabel={`${folded} more`}
          accessibilityRole="button"
          onPress={() => setOpen(true)}
          style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
        >
          <AppText role="caption" tone="soft">{`+${folded}`}</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

interface Chip {
  readonly acting: boolean;
  readonly destination: SurfaceDestination | null;
  readonly ended: boolean;
  readonly favicon: string | null;
  readonly glyph: "globe" | "laptopcomputer" | "smartphone";
  readonly key: string;
  readonly secondary: string | null;
  readonly title: string;
}

/**
 * One page or Mac app, as a chip: the site's icon, else the globe, or the
 * app's mark; its title; and its site muted after it. An ended page is still
 * named, dimmed, and opens nothing.
 */
function SurfaceChip(props: {
  readonly acting?: boolean;
  readonly ended: boolean;
  readonly favicon: string | null;
  readonly glyph: "globe" | "laptopcomputer" | "smartphone";
  readonly onPress: () => void;
  readonly secondary: string | null;
  readonly title: string;
}): ReactNode {
  // "www." says nothing a person reads a site by, and the chip has little room.
  const site = props.secondary?.replace(/^www\./u, "") || null;
  const label = [
    props.title,
    site,
    props.ended
      ? props.glyph === "globe"
        ? "closed"
        : "finished"
      : props.acting === true
        ? agentWorkingLabel.toLowerCase()
        : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
  return (
    <Pressable
      accessibilityHint={
        props.ended
          ? props.glyph === "globe"
            ? "This page was closed"
            : "The agent finished with this computer"
          : undefined
      }
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.ended }}
      disabled={props.ended}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chip,
        props.acting === true && !props.ended && styles.acting,
        pressed && styles.pressed,
        props.ended && styles.ended,
      ]}
    >
      {props.favicon !== null ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: props.favicon }}
          style={styles.favicon}
        />
      ) : props.glyph !== "laptopcomputer" ? (
        <Symbol name={props.glyph} size={12} tint={props.ended ? color.muted : color.textSoft} />
      ) : (
        <AppMark name={props.title} size={14} />
      )}
      <AppText
        numberOfLines={1}
        role="caption"
        style={styles.title}
        tone={props.ended ? "muted" : "default"}
      >
        {props.title}
      </AppText>
      {site === null || site === props.title ? null : (
        <AppText numberOfLines={1} role="caption" style={styles.site} tone="muted">
          {`· ${site}`}
        </AppText>
      )}
    </Pressable>
  );
}

/** The Mac apps a Run is holding now, one per app per Mac. */
const selectBrowserSessions = (snapshot: HostSnapshot) => snapshot.browserSessions;
const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const selectConnection = (snapshot: HostSnapshot) => snapshot.connection;

const styles = StyleSheet.create({
  acting: { borderColor: color.green },
  favicon: { borderRadius: 3, height: 14, width: 14 },
  chip: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    maxWidth: 280,
    minHeight: 32,
    paddingHorizontal: space[10] - (1 - StyleSheet.hairlineWidth),
  },
  ended: { opacity: 0.55 },
  // The message's column places these, so a person's own page stands at the end with their bubble.
  pages: { flexDirection: "row", flexWrap: "wrap", gap: space[6], justifyContent: "flex-end" },
  pressed: { ...material.platePressed },
  reply: { flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  // The title is what a person recognizes; the site gives way first.
  site: { flexShrink: 3, maxWidth: "45%" },
  title: { flexShrink: 1 },
});
