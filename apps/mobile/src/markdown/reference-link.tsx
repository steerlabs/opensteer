import {
  classifyLink,
  fileIcon,
  localTeamReference,
  referenceIcon,
  teamPageIcon,
  type IdReference as Reference,
} from "@opensteer/client/references";
import { useReference, useTabReference } from "@opensteer/client/react";
import type { TeamSessionClient } from "@opensteer/client/team";
import { type ClassifiedHref, type TeamPageLink } from "@opensteer/core";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { color, material, radius, space, type } from "../theme.js";
import { LinkHoldContext, useConversationLinks } from "../thread/link-context.js";
import { referenceSymbols } from "../ui/reference-symbols.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import {
  ReferenceVisibility,
  useReferenceNavigation,
  type ReferenceNavigation,
} from "./reference-context.js";

/** Words on the reader's own accent bubble take its ink, and a chip there its translucent plate. */
export const ChipInk = createContext<"page" | "accent">("page");

/**
 * A link someone wrote, drawn by what it names. Something in Opensteer is a
 * chip that opens it here; a web or mail address keeps the conversation's own
 * handling; anything else stays the words it was written with. An internal
 * link never reaches the system, a browser or the "Open on…" menu.
 */
export function ReferenceLink(props: {
  readonly children: ReactNode;
  readonly href: string;
  readonly label: string;
  /** Punctuation that closes on the link, drawn on the chip's line. */
  readonly trailing?: string | undefined;
}): ReactNode {
  const navigation = useReferenceNavigation();
  const link = classifyLink(props.href);
  const words = (element: ReactNode) => (
    <>
      {element}
      {props.trailing}
    </>
  );
  const chip = (element: ReactNode) => (
    <>
      <InlineChip trailing={props.trailing}>{element}</InlineChip>
      {/* An invisible, unbreakable character gives a line holding only chips the words'
          depth below the baseline on Android, which the dropped chip reaches into. */}
      {Platform.OS === "android" ? "\u2060" : null}
    </>
  );
  switch (link.kind) {
    case "reference":
      // Another person's Opensteer means nothing to a team reader: its words stay.
      return navigation?.context.kind === "personal"
        ? chip(
            <PersonalChip
              href={props.href}
              label={props.label}
              navigation={navigation}
              reference={link.reference}
            />,
          )
        : words(props.children);
    case "tab":
      return navigation?.context.kind === "personal"
        ? chip(
            <TabChip
              href={props.href}
              label={props.label}
              navigation={navigation}
              tabId={link.tabId}
            />,
          )
        : words(props.children);
    case "file":
      return navigation?.context.kind === "personal"
        ? chip(
            <FileChip file={link} href={props.href} label={props.label} navigation={navigation} />,
          )
        : words(props.children);
    case "team-page":
      return navigation === null
        ? words(props.children)
        : chip(
            <TeamPageChip
              href={props.href}
              label={props.label}
              navigation={navigation}
              page={link.page}
            />,
          );
    case "web":
    case "mail":
      return words(<WebLink url={link.url}>{props.children}</WebLink>);
    case "none":
      return words(props.children);
  }
}

/** The type of the words a chip sits in, which the punctuation after it is set in. */
export const ChipProse = createContext<StyleProp<TextStyle>>(null);

/**
 * A chip as one inline view, with the punctuation that closes on it, so a
 * period never wraps alone to the next line: the chip's title gives way first.
 */
function InlineChip(props: {
  readonly children: ReactNode;
  readonly trailing: string | undefined;
}): ReactNode {
  const prose = useContext(ChipProse);
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={[
        styles.inline,
        // Android stands an inline view on the baseline; drop it so its title's baseline is the line's.
        Platform.OS === "android" && { transform: [{ translateY: androidChipDrop(fontScale) }] },
      ]}
    >
      {props.children}
      {props.trailing ? (
        // As tall as the chip, so the two share a baseline whatever the words' own line height.
        <Text style={[styles.trailing, prose, { lineHeight: chipLineHeight + 2 / fontScale }]}>
          {props.trailing}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * For text holding a chip. Android's last line ends at the font's own depth, a
 * little short of a dropped chip's rim, which whatever holds the text would clip.
 */
export const chipRoom: TextStyle | null = Platform.OS === "android" ? { paddingBottom: 2 } : null;

/** Where the chip's title baseline meets the line's, measured on Android's system font at 1× and 1.5×. */
function androidChipDrop(fontScale: number): number {
  return 4.8 + 1.1 * fontScale;
}

function PersonalChip(props: {
  readonly href: string;
  readonly label: string;
  readonly navigation: ReferenceNavigation;
  readonly reference: Reference;
}): ReactNode {
  const { navigation } = props;
  const visible = useContext(ReferenceVisibility);
  const client = navigation.context.kind === "personal" ? navigation.context.client : null;
  const state = useReference(client, props.reference, { enabled: visible });
  const unavailable = state.state === "unavailable";
  return (
    <Chip
      glyph={referenceSymbols[referenceIcon(props.reference.kind)]}
      href={props.href}
      label={props.label}
      onPress={unavailable ? null : () => void navigation.open(props.href)}
      title={state.state === "available" ? state.value.title : props.label}
    />
  );
}

/** A tab in the person's list; a closed one stays a chip that opens nothing, never reopened. */
function TabChip(props: {
  readonly href: string;
  readonly label: string;
  readonly navigation: ReferenceNavigation;
  readonly tabId: string;
}): ReactNode {
  const { navigation } = props;
  const client = navigation.context.kind === "personal" ? navigation.context.client : null;
  const state = useTabReference(client, props.tabId);
  return (
    <Chip
      glyph={referenceSymbols.link}
      href={props.href}
      label={props.label}
      onPress={state.state === "unavailable" ? null : () => void navigation.open(props.href)}
      title={state.state === "available" ? state.tab.title.trim() || props.label : props.label}
    />
  );
}

function FileChip(props: {
  readonly file: Extract<ClassifiedHref, { kind: "file" }>;
  readonly href: string;
  readonly label: string;
  readonly navigation: ReferenceNavigation;
}): ReactNode {
  const { file } = props.file;
  const name = file.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? file.path;
  const position =
    file.line === undefined
      ? null
      : `:${file.line}${file.column === undefined ? (file.endLine === undefined ? "" : `-${file.endLine}`) : `:${file.column}`}`;
  return (
    <Chip
      glyph={referenceSymbols[fileIcon(name)]}
      href={props.href}
      label={props.label}
      onPress={() => void props.navigation.open(props.href)}
      secondary={position}
      title={name}
    />
  );
}

function TeamPageChip(props: {
  readonly href: string;
  readonly label: string;
  readonly navigation: ReferenceNavigation;
  readonly page: TeamPageLink;
}): ReactNode {
  const { context } = props.navigation;
  const held = useHeldTeamTitle(
    context.kind === "team" ? context.client : null,
    context.kind === "team" ? context.origin : null,
    props.page,
  );
  return (
    <Chip
      glyph={referenceSymbols[teamPageIcon(props.page.target.kind)]}
      href={props.href}
      label={props.label}
      onPress={() => void props.navigation.open(props.href)}
      title={held ?? props.label}
    />
  );
}

/** A team page's current name from what the team's session already holds; no read on mount. */
function useHeldTeamTitle(
  session: TeamSessionClient | null,
  origin: string | null,
  page: TeamPageLink,
): string | null {
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  const read = useCallback(() => {
    if (session === null || origin === null) return null;
    const snapshot = session.getSnapshot();
    return (
      localTeamReference(page, {
        origin,
        sidebar: snapshot.sidebar,
        channel: snapshot.channel,
        thread: snapshot.thread,
      })?.title ?? null
    );
  }, [origin, page, session]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The transcript's chip, shrunk to sit in a line of words: the plate and rim
 * of a page chip, a glyph for what it names, and its title on one line. What
 * is gone keeps its words, dashed and muted, and opens nothing.
 */
function Chip(props: {
  readonly glyph: SFSymbolName;
  readonly href: string;
  readonly label: string;
  /** Null when what it names is confirmed gone. */
  readonly onPress: (() => void) | null;
  readonly secondary?: string | null;
  readonly title: string;
}): ReactNode {
  const hold = useContext(LinkHoldContext);
  const ink = useContext(ChipInk);
  const { fontScale, width } = useWindowDimensions();
  // An inline view is measured unconstrained, so the title carries the cap: never wider than
  // most of a line, which leaves room for the glyph, the position and the rim.
  const titleWidth = Math.max(96, Math.min(width - 112, 240 * fontScale));
  const gone = props.onPress === null;
  const link = { href: props.href, label: props.label };
  const accent = ink === "accent";
  return (
    <Pressable
      accessibilityHint={gone ? "No longer available" : undefined}
      accessibilityLabel={props.title + (props.secondary ?? "")}
      accessibilityRole="link"
      accessibilityState={{ disabled: gone }}
      disabled={gone}
      onLongPress={hold && !gone ? () => hold.hold(link) : undefined}
      onPress={props.onPress ?? undefined}
      onPressIn={
        hold && !gone ? (event) => hold.press(link, event.nativeEvent.timestamp) : undefined
      }
      style={({ pressed }) => [
        styles.chip,
        accent ? styles.accentChip : material.plate,
        gone && (accent ? styles.accentGone : styles.gone),
        pressed && !gone && styles.pressed,
      ]}
    >
      <Symbol
        name={props.glyph}
        size={Math.round(13 * fontScale)}
        tint={accent ? color.bubbleInk : gone ? color.mutedDim : color.textSoft}
      />
      <Text
        numberOfLines={1}
        style={[
          styles.title,
          { maxWidth: titleWidth },
          accent && styles.accentText,
          gone && !accent && styles.goneText,
        ]}
      >
        {props.title}
      </Text>
      {/* The position stays whole; the name gives way first. */}
      {props.secondary ? (
        <Text
          numberOfLines={1}
          style={[styles.title, accent ? styles.accentSecondary : styles.secondary]}
        >
          {props.secondary}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A web or mail address. In a conversation it opens where the conversation
 * says; anywhere else it goes to the system, as it always has.
 */
function WebLink(props: { readonly children: ReactNode; readonly url: string }): ReactNode {
  const { url } = props;
  const links = useConversationLinks();
  const hold = useContext(LinkHoldContext);
  const ink = useContext(ChipInk);
  const link = { href: url, label: url };
  return (
    <Text
      accessibilityRole="link"
      onLongPress={hold ? () => hold.hold(link) : undefined}
      onPress={() => {
        if (links) links.open(url);
        // Outside a conversation a link goes to the system, which decides what opens it.
        else void Linking.openURL(url).catch(() => Alert.alert("Link could not be opened", url));
      }}
      onPressIn={hold ? (event) => hold.press(link, event.nativeEvent.timestamp) : undefined}
      style={ink === "accent" ? styles.accentLink : styles.link}
    >
      {props.children}
    </Text>
  );
}

const chipLineHeight = 19;

const styles = StyleSheet.create({
  accentChip: {
    backgroundColor: "rgba(27, 18, 14, 0.08)",
    borderColor: "rgba(27, 18, 14, 0.22)",
    borderWidth: 1,
  },
  accentGone: { backgroundColor: "transparent", borderStyle: "dashed", opacity: 0.7 },
  accentLink: { color: color.bubbleInk, textDecorationLine: "underline" },
  accentSecondary: { color: "rgba(27, 18, 14, 0.6)", flexShrink: 0, marginLeft: -space[4] },
  accentText: { color: color.bubbleInk },
  // Inline in a line of words, no taller than the line.
  chip: {
    alignItems: "center",
    flexShrink: 1,
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[4],
    paddingLeft: space[6] - 1,
    paddingRight: space[8] - 1,
    paddingVertical: 0,
  },
  gone: {
    backgroundColor: "transparent",
    backgroundImage: "none",
    borderColor: color.lineStrong,
    borderStyle: "dashed",
    boxShadow: [],
  },
  goneText: { color: color.muted },
  inline: { alignItems: "flex-start", flexDirection: "row", maxWidth: "100%" },
  link: { color: color.ember, textDecorationLine: "underline" },
  pressed: { ...material.platePressed },
  // Set tight against the name it qualifies, inside the glyph gap.
  secondary: { color: color.muted, flexShrink: 0, marginLeft: -space[4] },
  trailing: { ...type.body, color: color.text, flexShrink: 0 },
  title: { color: color.text, flexShrink: 1, fontSize: 15, lineHeight: chipLineHeight },
});
