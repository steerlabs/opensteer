import { localTeamReference } from "@opensteer/client/references";
import { useReference } from "@opensteer/client/react";
import type { TeamSessionClient } from "@opensteer/client/team";
import {
  classifyHref,
  type ClassifiedHref,
  type Reference,
  type ReferenceKind,
  type TeamPageLink,
} from "@opensteer/core";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, useWindowDimensions } from "react-native";
import { color, material, radius, space } from "../theme.js";
import { LinkHoldContext, useConversationLinks } from "../thread/link-context.js";
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
}): ReactNode {
  const navigation = useReferenceNavigation();
  const link = classifyHref(props.href);
  switch (link.kind) {
    case "reference":
      // Another person's Opensteer means nothing to a team reader: its words stay.
      return navigation?.context.kind === "personal" ? (
        <PersonalChip
          href={props.href}
          label={props.label}
          navigation={navigation}
          reference={link.reference}
        />
      ) : (
        props.children
      );
    case "file":
      return navigation?.context.kind === "personal" ? (
        <FileChip file={link} href={props.href} label={props.label} navigation={navigation} />
      ) : (
        props.children
      );
    case "team-page":
      return navigation === null ? (
        props.children
      ) : (
        <TeamPageChip
          href={props.href}
          label={props.label}
          navigation={navigation}
          page={link.page}
        />
      );
    case "web":
    case "mail":
      return <WebLink url={link.url}>{props.children}</WebLink>;
    case "none":
      return props.children;
  }
}

const referenceGlyph: Record<ReferenceKind, SFSymbolName> = {
  task: "bubble.left",
  run: "waveform.path.ecg",
  request: "hand.raised",
  message: "text.quote",
  automation: "clock",
  computer: "desktopcomputer",
  attachment: "paperclip",
};

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
      glyph={referenceGlyph[props.reference.kind]}
      href={props.href}
      label={props.label}
      onPress={unavailable ? null : () => void navigation.open(props.href)}
      title={state.state === "available" ? state.value.title : props.label}
    />
  );
}

const imageName = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/iu;

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
      glyph={imageName.test(name) ? "photo" : "doc"}
      href={props.href}
      label={props.label}
      onPress={() => void props.navigation.open(props.href)}
      secondary={position}
      title={name}
    />
  );
}

const teamGlyph: Record<TeamPageLink["target"]["kind"], SFSymbolName> = {
  invite: "person.badge.plus",
  channel: "number",
  message: "number",
  thread: "bubble.left.and.bubble.right",
  "knowledge-topic": "folder",
  "knowledge-note": "doc.text",
};

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
      glyph={teamGlyph[props.page.target.kind]}
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
  link: { color: color.ember, textDecorationLine: "underline" },
  pressed: { ...material.platePressed },
  // Set tight against the name it qualifies, inside the glyph gap.
  secondary: { color: color.muted, flexShrink: 0, marginLeft: -space[4] },
  title: { color: color.text, flexShrink: 1, fontSize: 15, lineHeight: 19 },
});
