import {
  messagePages,
  placePage,
  replyPlaces,
  type HostClient,
  type HostSnapshot,
  type PlaceEntry,
  type TabDestination,
  type Turn,
} from "@opensteer/client/host";
import { useHostSelector, useTabsRevision } from "@opensteer/client/react";
import { RunnerIdSchema } from "@opensteer/core";
import type {
  BrowserPageContentPart,
  ComputerAppContentPart,
  PhoneContentPart,
  TabId,
} from "@opensteer/core";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { color, material, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { ActingDot, agentWorkingLabel } from "../browser/acting-dot.js";
import { AppMark } from "../computers/app-mark.js";

/**
 * How transcript rows reach the pages and apps they name. Rows are memoized
 * on their entries, and a browser opens, changes title and ends without
 * touching one, so the chips read the Host's browsers from here.
 */
export interface TranscriptSurfaces {
  readonly hostClient: HostClient;
  /** The conversation on screen, whose agent a page's live dot is for. */
  readonly threadId: string;
  /** Each stretch's turn key finds the gathered work of its owning reply. */
  readonly turns?: ReadonlyMap<string, SurfaceTurn>;
  /** Opens exactly this page or app; nothing stands in for one that has gone. */
  readonly open: (destination: TabDestination) => void;
}

export const TranscriptSurfacesContext = createContext<TranscriptSurfaces | null>(null);

/**
 * How an app's card reaches its tab. Apart from the surfaces above, whose value
 * changes with every streamed token, so a card never redraws on one.
 */
export interface TranscriptAppTabs {
  /** Shows the app's tab, opened from this conversation. */
  readonly show: (tabId: TabId) => void;
}

export const TranscriptAppTabsContext = createContext<TranscriptAppTabs | null>(null);

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
  const source = useTabSource(props.surfaces.hostClient);
  const pages = useMemo(() => messagePages(props.pages, source), [props.pages, source]);
  return (
    <View style={styles.pages}>
      {pages.map((page) => (
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
 * The apps and phones a person included with their message, beside its pages:
 * named as they were sent, even once gone. A phone is its own address and
 * opens while its view does; an app names no session of its own, so it is
 * only named, never opened by commandeering one.
 */
export function MessagePlaces(props: {
  readonly places: readonly (ComputerAppContentPart | PhoneContentPart)[];
}): ReactNode {
  const surfaces = useContext(TranscriptSurfacesContext);
  if (surfaces === null || props.places.length === 0) return null;
  return <IncludedPlaces places={props.places} surfaces={surfaces} />;
}

function IncludedPlaces(props: {
  readonly places: readonly (ComputerAppContentPart | PhoneContentPart)[];
  readonly surfaces: TranscriptSurfaces;
}): ReactNode {
  const machines = useHostSelector(props.surfaces.hostClient, selectMachines);
  const connection = useHostSelector(props.surfaces.hostClient, selectConnection);
  return (
    <View style={styles.pages}>
      {props.places.map((part) => {
        if (part.type === "computer-app")
          return (
            <SurfaceChip
              ended={false}
              favicon={null}
              glyph="laptopcomputer"
              key={`app:${part.machineId}:${part.app.bundleId}`}
              onPress={null}
              secondary={null}
              title={part.name}
            />
          );
        const machine = machines.find(({ id }) => id === part.machineId);
        // A phone opens its one tab, which wakes it only for this explicit Open.
        const open = connection === "connected" && machine !== undefined;
        return (
          <SurfaceChip
            ended={!open}
            favicon={null}
            glyph="smartphone"
            key={`phone:${part.machineId}:${part.display}`}
            onPress={() => {
              // The person's Open of its one tab, which may wake it once when shown.
              const computerId = RunnerIdSchema.safeParse(part.machineId);
              if (!computerId.success) return;
              void props.surfaces.hostClient
                .openTab({ kind: "phone", computerId: computerId.data })
                .then((tab) => props.surfaces.open({ kind: "tab", tabId: tab.tabId }))
                .catch(() => undefined);
            }}
            secondary={null}
            title={part.name}
          />
        );
      })}
    </View>
  );
}

/**
 * The pages its Run used and apps and phones its steps used, under the reply.
 * Three show; the rest fold behind "+N", which opens them in place.
 */
type SurfaceTurn = Pick<Turn, "runId" | "work">;

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
  const source = useTabSource(surfaces.hostClient);
  const uses = useHostSelector(surfaces.hostClient, selectBrowserUses);
  const [open, setOpen] = useState(false);
  const chips = useMemo(
    (): readonly Chip[] =>
      replyPlaces(turn, uses, source).map((place): Chip =>
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
    [source, turn, uses],
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

/**
 * Where the Run began acting in a browser tab: a stop on the trace's line, not
 * a step. It names the page as it was then and opens that exact tab while it
 * is open; a closed one stays, dimmed, and opens nothing. `latest` is whether
 * it is the turn's newest stop, the only one its agent can be acting at now.
 */
export function TracePlace(props: {
  readonly entry: PlaceEntry;
  readonly markOnly?: boolean;
  readonly latest: boolean;
}): ReactNode {
  const surfaces = useContext(TranscriptSurfacesContext);
  if (surfaces === null) return null;
  return (
    <PlaceStop
      entry={props.entry}
      latest={props.latest}
      markOnly={props.markOnly === true}
      surfaces={surfaces}
    />
  );
}

function PlaceStop(props: {
  readonly entry: PlaceEntry;
  readonly markOnly?: boolean;
  readonly latest: boolean;
  readonly surfaces: TranscriptSurfaces;
}): ReactNode {
  const { surfaces } = props;
  const source = useTabSource(surfaces.hostClient);
  const page = useMemo(() => placePage(props.entry, source), [props.entry, source]);
  if (page === null) return null;
  // An agent is in one tab at a time: the live turn's latest stop, while its tab is listed.
  const acting = props.latest && !page.ended;
  if (props.markOnly)
    return (
      <View style={{ flexDirection: "row" }}>
        {page.favicon !== null ? (
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: page.favicon }}
            style={styles.favicon}
          />
        ) : (
          <Symbol name="globe" size={12} tint={color.muted} />
        )}
        {acting ? <ActingDot grouped /> : null}
      </View>
    );
  const site = page.site;
  return (
    <Pressable
      accessibilityHint={page.ended ? "This page was closed" : "Opens this page"}
      accessibilityLabel={[
        page.title,
        site,
        page.ended ? "closed" : acting ? agentWorkingLabel.toLowerCase() : null,
      ]
        .filter((part): part is string => part !== null && part !== "")
        .join(", ")}
      accessibilityRole="button"
      accessibilityState={{ disabled: page.ended }}
      disabled={page.ended}
      onPress={() => surfaces.open(page.destination)}
      style={({ pressed }) => [
        styles.stop,
        pressed && styles.stopPressed,
        page.ended && styles.ended,
      ]}
    >
      <View style={styles.stopMark}>
        <View style={[styles.stopLine, styles.stopLineAbove]} />
        {page.favicon !== null ? (
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: page.favicon }}
            style={styles.favicon}
          />
        ) : (
          <Symbol name="globe" size={12} tint={color.muted} />
        )}
        <View style={[styles.stopLine, styles.stopLineBelow]} />
      </View>
      <AppText numberOfLines={1} role="caption" style={styles.title} tone="soft">
        {page.title}
      </AppText>
      {site === null || site === page.title ? null : (
        <AppText numberOfLines={1} role="caption" style={styles.site} tone="muted">
          {`· ${site}`}
        </AppText>
      )}
      {acting ? <ActingDot grouped /> : null}
    </Pressable>
  );
}

interface Chip {
  readonly acting: boolean;
  readonly destination: TabDestination | null;
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
  /** Null for a chip that only names what it was. */
  readonly onPress: (() => void) | null;
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
      accessibilityRole={props.onPress === null ? "text" : "button"}
      accessibilityState={{ disabled: props.ended }}
      disabled={props.ended || props.onPress === null}
      onPress={props.onPress ?? undefined}
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
const selectBrowserUses = (snapshot: HostSnapshot) => snapshot.browserUses;
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
  /** A stop sits in the step icons' column, on a hairline that fades both ways. */
  stop: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[8],
    marginHorizontal: -space[8],
    maxWidth: "100%",
    minHeight: 36,
    paddingHorizontal: space[8],
  },
  stopLine: {
    backgroundColor: color.lineStrong,
    flex: 1,
    width: StyleSheet.hairlineWidth,
  },
  stopLineAbove: { marginBottom: space[4], opacity: 0.6 },
  stopLineBelow: { marginTop: space[4], opacity: 0.6 },
  stopMark: { alignItems: "center", alignSelf: "stretch", width: space[20] },
  stopPressed: { ...material.platePressed },
  // The message's column places these, so a person's own page stands at the end with their bubble.
  pages: { flexDirection: "row", flexWrap: "wrap", gap: space[6], justifyContent: "flex-end" },
  pressed: { ...material.platePressed },
  reply: { flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  // The title is what a person recognizes; the site gives way first.
  site: { flexShrink: 3, maxWidth: "45%" },
  title: { flexShrink: 1 },
});

/**
 * The tab list and profiles chips are named from, as one value that changes
 * with any tab row, so a chip shows its tab's current title.
 */
function useTabSource(hostClient: HostClient): Pick<HostSnapshot, "tabs" | "browserProfiles"> {
  const revision = useTabsRevision(hostClient);
  const profiles = useHostSelector(hostClient, selectProfiles);
  return useMemo(
    () => ({ browserProfiles: profiles, tabs: hostClient.getSnapshot().tabs }),
    // A new revision is a new value: a chip reads the rows it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hostClient, profiles, revision],
  );
}
const selectProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;
