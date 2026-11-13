import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { Avatar, TeamTile } from "./team-marks.js";
import type { SearchFilter, SearchMessageResult, TeamTileView } from "./team-models.js";

export interface SearchFilters {
  /** "#support". */
  readonly channel: string | null;
  /** "Maya Chen", or "Maya's agent". */
  readonly author: string | null;
  readonly thread: boolean;
  readonly file: boolean;
}

export interface SearchMessageGroup {
  readonly team: TeamTileView;
  readonly results: readonly SearchMessageResult[];
  readonly more: boolean;
}

/**
 * One field for a team's messages. Filters are the four the team server
 * answers: a channel, an author, in threads, has a file. Results open where
 * they live, and Back returns here.
 */
export function SearchBody(props: {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly filters: SearchFilters;
  /** Thread and file toggle. */
  readonly onFilter: (filter: Extract<SearchFilter, "thread" | "file">) => void;
  /** Channel and author are chosen from the team's own channels and people. */
  readonly channelChoices: readonly NativeMenuOption[];
  readonly authorChoices: readonly NativeMenuOption[];
  readonly groups: readonly SearchMessageGroup[];
  readonly searching: boolean;
  /** The last search didn't answer; it is never shown as "nothing matches". */
  readonly failure: string | null;
  readonly onRetry: () => void;
  readonly onOpenMessage: (teamId: string, result: SearchMessageResult) => void;
  readonly onMore: (teamId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  const { filters } = props;
  const nothing =
    props.query.trim() !== "" &&
    !props.searching &&
    props.failure === null &&
    // Older pages still to read are never "nothing".
    props.groups.every((group) => group.results.length === 0 && !group.more);
  return (
    <View style={styles.fill}>
      <View style={styles.top}>
        <View style={styles.field}>
          <SearchField
            autoFocus
            onChange={props.onQuery}
            placeholder="Search messages"
            value={props.query}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.chips}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          <FilterMenu
            choices={props.channelChoices}
            icon="number"
            label={filters.channel ?? "In"}
            on={filters.channel !== null}
            title="Search in"
          />
          <FilterMenu
            choices={props.authorChoices}
            icon="person"
            label={filters.author ?? "From"}
            on={filters.author !== null}
            title="From"
          />
          <FilterChip
            icon="bubble.left"
            label="In threads"
            on={filters.thread}
            onPress={() => props.onFilter("thread")}
          />
          <FilterChip
            icon="paperclip"
            label="Has a file"
            on={filters.file}
            onPress={() => props.onFilter("file")}
          />
        </ScrollView>
      </View>
      <ScrollView
        contentContainerStyle={[styles.results, { paddingBottom: props.paddingBottom }]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {props.failure === null ? null : (
          <Notice
            action={{ label: "Try again", onPress: props.onRetry }}
            detail={props.failure}
            title="Search didn't answer"
            tone="neutral"
          />
        )}
        {nothing ? (
          <AppText role="secondary" style={styles.nothing} tone="muted">
            Nothing matches “{props.query.trim()}”.
          </AppText>
        ) : null}
        {props.groups.map((group) =>
          group.results.length === 0 && !group.more ? null : (
            <View key={group.team.id} style={styles.group}>
              <View style={styles.groupHead}>
                <TeamTile size={16} team={group.team} />
                <AppText role="secondaryMedium" style={styles.groupLabel} tone="muted">
                  {group.team.name} · {group.results.length}
                  {group.more ? "+" : ""}{" "}
                  {group.results.length === 1 && !group.more ? "message" : "messages"}
                </AppText>
              </View>
              {group.results.map((result) => (
                <ResultRow
                  key={result.message.id}
                  onOpen={() => props.onOpenMessage(group.team.id, result)}
                  result={result}
                />
              ))}
              {group.more ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => props.onMore(group.team.id)}
                  style={styles.more}
                >
                  <AppText role="caption" style={styles.moreLabel}>
                    More in {group.team.name}
                  </AppText>
                </Pressable>
              ) : null}
            </View>
          ),
        )}
      </ScrollView>
    </View>
  );
}

function ResultRow(props: {
  readonly onOpen: () => void;
  readonly result: SearchMessageResult;
}): ReactNode {
  const { message } = props.result;
  const agent = message.author.kind === "agent" ? message.author.agent : null;
  const person =
    message.author.kind === "agent" ? message.author.agent.owner : message.author.person;
  return (
    <Pressable
      accessibilityHint="Opens it where it was posted"
      accessibilityRole="button"
      onPress={props.onOpen}
      style={({ pressed }) => [styles.result, pressed && styles.pressed]}
    >
      <Avatar agent={agent !== null} person={person} size={28} />
      <View style={styles.grow}>
        <View style={styles.resultHead}>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
            style={styles.name}
          >
            {agent?.byline ?? person.name}
          </AppText>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="caption"
            style={styles.where}
          >
            {props.result.where} · {message.time}
          </AppText>
        </View>
        <Highlighted match={props.result.match} text={plainText(message.text)} />
      </View>
    </Pressable>
  );
}

/** The matched words lit in the message's plain text, a few lines at most. */
function Highlighted(props: { readonly match: string; readonly text: string }): ReactNode {
  const at = props.match === "" ? -1 : props.text.toLowerCase().indexOf(props.match.toLowerCase());
  if (at < 0) {
    return (
      <AppText numberOfLines={3} role="secondary" tone="soft">
        {props.text}
      </AppText>
    );
  }
  // Start a little before a match deep in a long message, so the match is on screen.
  const from = at > 80 ? props.text.lastIndexOf(" ", at - 40) + 1 : 0;
  return (
    <Text numberOfLines={3} style={styles.excerpt}>
      {from > 0 ? "…" : ""}
      {props.text.slice(from, at)}
      <Text style={styles.hit}>{props.text.slice(at, at + props.match.length)}</Text>
      {props.text.slice(at + props.match.length)}
    </Text>
  );
}

/** Markdown's marks dropped, for an excerpt. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~`>#]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A picker chip: the platform's own menu of the choices, the one in force checked. */
function FilterMenu(props: {
  readonly choices: readonly NativeMenuOption[];
  readonly icon: SFSymbolName;
  readonly label: string;
  readonly on: boolean;
  readonly title: string;
}): ReactNode {
  return (
    <NativeMenu
      accessibilityLabel={`${props.title}: ${props.label}`}
      options={props.choices}
      title={props.title}
      triggerStyle={[styles.chip, props.on && styles.chipOn]}
    >
      <Symbol
        name={props.icon}
        size={12}
        tint={props.on ? color.ember : color.muted}
        weight="semibold"
      />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={props.on ? styles.chipLabelOn : styles.chipLabel}
      >
        {props.label}
      </AppText>
      <Symbol
        name="chevron.down"
        size={10}
        tint={props.on ? color.ember : color.muted}
        weight="semibold"
      />
    </NativeMenu>
  );
}

function FilterChip(props: {
  readonly icon: SFSymbolName;
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
  readonly picker?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole={props.picker === true ? "button" : "switch"}
      accessibilityState={props.picker === true ? undefined : { checked: props.on }}
      hitSlop={{ bottom: 6, top: 6 }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chip,
        props.on && styles.chipOn,
        pressed && styles.chipPressed,
      ]}
    >
      <Symbol
        name={props.icon}
        size={12}
        tint={props.on ? color.ember : color.muted}
        weight="semibold"
      />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={props.on ? styles.chipLabelOn : styles.chipLabel}
      >
        {props.label}
      </AppText>
      {props.picker === true ? (
        <Symbol
          name="chevron.down"
          size={10}
          tint={props.on ? color.ember : color.muted}
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[4],
    height: 32,
    paddingHorizontal: space[10] - 1,
  },
  chipLabel: { color: color.textSoft, fontWeight: "600" },
  chipLabelOn: { color: color.ember, fontWeight: "600" },
  chipOn: { backgroundColor: color.emberWash, borderColor: color.emberLine },
  chipPressed: { ...material.platePressed },
  chips: { gap: space[6], paddingHorizontal: space[16], paddingVertical: space[2] },
  excerpt: { ...type.secondary, color: color.textSoft },
  field: { paddingHorizontal: space[16] },
  fill: { flex: 1 },
  group: { gap: space[2] },
  groupHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    paddingHorizontal: space[4],
  },
  groupLabel: { paddingVertical: space[6] },
  grow: { flex: 1, minWidth: 0 },
  hit: { backgroundColor: color.amberWash, color: color.amber, fontWeight: "600" },
  more: { justifyContent: "center", minHeight: touchTarget, paddingLeft: space[4] },
  moreLabel: { color: color.ember, fontWeight: "600" },
  name: { flexShrink: 1, fontWeight: "600" },
  nothing: { paddingVertical: space[24], textAlign: "center" },
  pressed: { ...material.quiet },
  result: {
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[10],
    paddingHorizontal: space[6],
    paddingVertical: space[8],
  },
  resultHead: { alignItems: "baseline", flexDirection: "row", gap: space[6] },
  results: { gap: space[16], paddingHorizontal: space[10], paddingTop: space[8] },
  top: { gap: space[8], paddingBottom: space[6], paddingTop: space[4] },
  where: { color: color.mutedDim, flexShrink: 1 },
});
