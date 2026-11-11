import type { ReactNode } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  material,
  plateFill,
  radius,
  space,
  touchTarget,
} from "../theme.js";
import { AppText, RowGroup, SectionLabel } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { MessageBody } from "./message-body.js";
import { Avatar, PeopleOnlyBadge } from "./team-marks.js";
import type { FileRowView, PinnedRowView, ThingView, TopicSummaryView } from "./team-models.js";

export type FileKindFilter = "all" | "images" | "documents" | "other";

/**
 * A channel's files: every attachment its messages carry, newest first.
 * Images show their small preview; nothing downloads until it is opened.
 */
export function FilesBody(props: {
  readonly files: readonly FileRowView[];
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly filter: FileKindFilter;
  readonly onFilter: (filter: FileKindFilter) => void;
  readonly onOpen: (file: FileRowView) => void;
  readonly onShowMessage: (messageId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}
      keyboardShouldPersistTaps="handled"
    >
      <SearchField onChange={props.onQuery} placeholder="Find files" value={props.query} />
      <Segments
        onChange={props.onFilter}
        options={[
          ["all", "All"],
          ["images", "Images"],
          ["documents", "Documents"],
          ["other", "Other"],
        ]}
        value={props.filter}
      />
      {props.files.length === 0 ? (
        <Empty
          text={props.query === "" ? "Files shared here will appear here." : "No files match."}
        />
      ) : (
        <RowGroup>
          {props.files.map((file) => (
            <Pressable
              accessibilityHint="Opens the file"
              accessibilityLabel={`${file.attachment.name}, ${file.attachment.size}, shared by ${file.sharedBy}, ${file.when}`}
              accessibilityRole="button"
              key={file.id}
              onLongPress={() => props.onShowMessage(file.messageId)}
              onPress={() => props.onOpen(file)}
              style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
            >
              {file.attachment.preview === null ? (
                <View style={[styles.thumb, styles.thumbFile]}>
                  <Symbol name="doc.text" size={17} tint={color.textSoft} />
                </View>
              ) : (
                <Image source={{ uri: file.attachment.preview.uri }} style={styles.thumb} />
              )}
              <View style={styles.words}>
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  numberOfLines={1}
                  role="body"
                >
                  {file.attachment.name}
                </AppText>
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  numberOfLines={1}
                  role="caption"
                  tone="muted"
                >
                  {file.sharedBy} · {file.when} · {file.attachment.size}
                </AppText>
              </View>
              {file.pinned ? (
                <Symbol accessibilityLabel="Pinned" name="pin" size={13} tint={color.amber} />
              ) : null}
            </Pressable>
          ))}
        </RowGroup>
      )}
    </ScrollView>
  );
}

/** Pinned messages, newest pin first. Any member pins and unpins. */
export function PinnedBody(props: {
  readonly pins: readonly PinnedRowView[];
  readonly onShow: (messageId: string) => void;
  readonly onUnpin: (messageId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  if (props.pins.length === 0) {
    return <Empty text="Pin a message to keep it here. Hold any message, then Pin." />;
  }
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      {props.pins.map(({ message, pinnedBy }) => {
        const author =
          message.author.kind === "agent" ? message.author.agent.owner : message.author.person;
        const name =
          message.author.kind === "agent"
            ? message.author.agent.byline
            : message.author.person.name;
        return (
          <View key={message.id} style={styles.pin}>
            <View style={styles.pinHead}>
              <Avatar
                agent={message.author.kind === "agent"}
                ground={plateFill}
                person={author}
                size={24}
              />
              <AppText numberOfLines={1} role="secondaryMedium" style={styles.pinName}>
                {name}
              </AppText>
              <AppText role="caption" tone="muted">
                {message.time}
              </AppText>
            </View>
            <MessageBody mentions={message.mentions} text={message.text} />
            <View style={styles.pinFoot}>
              <Symbol name="pin" size={12} tint={color.amber} />
              <AppText role="caption" style={styles.pinBy} tone="muted">
                {pinnedBy}
              </AppText>
              <TextButton label="View in channel" onPress={() => props.onShow(message.id)} />
              <TextButton label="Unpin" onPress={() => props.onUnpin(message.id)} />
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

/**
 * The channel's shared memory: its own knowledge topic and any shared topics
 * attached to it. Attaching a topic grants nobody access; each topic keeps
 * its own list, and a people-only topic is never offered to agents.
 */
export function KnowledgeTopicsBody(props: {
  readonly topics: readonly TopicSummaryView[];
  readonly onOpen: (topicId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  const own = props.topics.filter((topic) => topic.kind === "channel");
  const shared = props.topics.filter((topic) => topic.kind === "shared");
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      {[
        { label: "This channel", topics: own },
        { label: "Attached", topics: shared },
      ].map((group) =>
        group.topics.length === 0 ? null : (
          <View key={group.label} style={styles.group}>
            <SectionLabel>{group.label}</SectionLabel>
            <RowGroup>
              {group.topics.map((topic) => (
                <Pressable
                  accessibilityLabel={`${topic.name}, ${topic.factCount} facts, ${topic.access}${topic.peopleOnly ? ", people only" : ""}`}
                  accessibilityRole="button"
                  key={topic.id}
                  onPress={() => props.onOpen(topic.id)}
                  style={({ pressed }) => [styles.topic, pressed && styles.pressed]}
                >
                  <Symbol name="tablecells" size={17} tint={color.muted} />
                  <View style={styles.words}>
                    <View style={styles.topicTitle}>
                      <AppText
                        maxFontSizeMultiplier={controlFontScaleLimit}
                        numberOfLines={1}
                        role="body"
                        style={styles.shrink}
                      >
                        {topic.name}
                      </AppText>
                      {topic.peopleOnly ? <PeopleOnlyBadge compact /> : null}
                    </View>
                    <AppText
                      maxFontSizeMultiplier={controlFontScaleLimit}
                      numberOfLines={1}
                      role="caption"
                      tone="muted"
                    >
                      {topic.factCount} facts · {topic.access}
                    </AppText>
                  </View>
                  <Symbol name="chevron.right" size={13} tint={color.mutedDim} weight="semibold" />
                </Pressable>
              ))}
            </RowGroup>
          </View>
        ),
      )}
    </ScrollView>
  );
}

/**
 * One topic: its things and their facts, each with who wrote it (a person or
 * someone's agent), when, and the message it came from. Editing appends a
 * version; History shows every one.
 */
export function KnowledgeTopicBody(props: {
  readonly topic: TopicSummaryView;
  readonly things: readonly ThingView[];
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly canWrite: boolean;
  readonly onAddFact: () => void;
  readonly onHistory: (thingId: string) => void;
  readonly onSource: (messageId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.topicHead}>
        <AppText role="secondary" tone="muted">
          {props.topic.access} · {props.topic.factCount} facts
        </AppText>
        {props.topic.peopleOnly ? <PeopleOnlyBadge /> : null}
      </View>
      <View style={styles.findRow}>
        <View style={styles.grow}>
          <SearchField
            onChange={props.onQuery}
            placeholder="Find in this topic"
            value={props.query}
          />
        </View>
        {props.canWrite ? (
          <Pressable
            accessibilityLabel="Add a fact"
            accessibilityRole="button"
            onPress={props.onAddFact}
            style={({ pressed }) => [styles.add, pressed && styles.addPressed]}
          >
            <Symbol name="plus" size={16} tint={color.inkOnEmber} weight="semibold" />
          </Pressable>
        ) : null}
      </View>
      {props.things.length === 0 ? (
        <Empty
          text={
            props.query === ""
              ? "Nothing here yet. Agents and people add facts as they learn them."
              : "Nothing matches."
          }
        />
      ) : (
        props.things.map((thing) => (
          <View key={thing.id} style={styles.thing}>
            <View style={styles.thingHead}>
              <View style={styles.words}>
                <AppText role="title">{thing.name}</AppText>
                <AppText role="caption" tone="muted">
                  {thing.key}
                </AppText>
              </View>
              <TextButton label="History" onPress={() => props.onHistory(thing.id)} />
            </View>
            {thing.facts.map((fact) => (
              <View key={fact.id} style={styles.fact}>
                <AppText role="caption" style={styles.property}>
                  {fact.property}
                </AppText>
                <AppText role="body" selectable>
                  {fact.value}
                </AppText>
                <View style={styles.factFoot}>
                  <AppText role="caption" tone="muted">
                    {fact.writer} · {fact.when}
                  </AppText>
                  {fact.sourceMessageId === null ? null : (
                    <TextButton
                      label="Source"
                      onPress={() => props.onSource(fact.sourceMessageId!)}
                    />
                  )}
                </View>
              </View>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Segments<T extends string>(props: {
  readonly options: readonly (readonly [T, string])[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <View accessibilityRole="tablist" style={styles.segments}>
      {props.options.map(([value, label]) => {
        const on = value === props.value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            key={value}
            onPress={() => props.onChange(value)}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              style={on ? styles.segmentLabelOn : styles.segmentLabel}
            >
              {label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function TextButton(props: { readonly label: string; readonly onPress: () => void }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={{ bottom: 12, left: 6, right: 6, top: 12 }}
      onPress={props.onPress}
    >
      <AppText role="caption" style={styles.textButton}>
        {props.label}
      </AppText>
    </Pressable>
  );
}

function Empty(props: { readonly text: string }): ReactNode {
  return (
    <View style={styles.empty}>
      <AppText role="secondary" style={styles.emptyText} tone="muted">
        {props.text}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  add: {
    ...material.accent,
    alignItems: "center",
    borderRadius: radius.full,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  addPressed: { ...material.accentPressed },
  empty: { alignItems: "center", padding: space[32] },
  emptyText: { textAlign: "center" },
  fact: {
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 2,
    paddingTop: space[10],
  },
  factFoot: { alignItems: "center", flexDirection: "row", gap: space[12] },
  fileRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 12,
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
  findRow: { alignItems: "center", flexDirection: "row", gap: space[8] },
  group: { gap: space[8] },
  grow: { flex: 1 },
  page: { gap: space[16], padding: space[16] },
  pin: {
    ...material.plate,
    borderLeftColor: color.amber,
    borderLeftWidth: 2,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  pinBy: { flex: 1 },
  pinFoot: { alignItems: "center", flexDirection: "row", gap: space[12] },
  pinHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
  pinName: { flexShrink: 1, fontWeight: "600" },
  pressed: { backgroundColor: color.surfacePressed },
  property: { color: color.muted, fontWeight: "600" },
  segment: {
    alignItems: "center",
    borderRadius: radius.sm,
    flex: 1,
    justifyContent: "center",
    minHeight: 32,
  },
  segmentLabel: { color: color.muted, fontWeight: "600" },
  segmentLabelOn: { color: color.text, fontWeight: "600" },
  segmentOn: { ...material.selected },
  segments: {
    ...material.plate,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: 2,
    padding: 2,
  },
  shrink: { flexShrink: 1 },
  textButton: { color: color.ember, fontWeight: "600" },
  thing: { ...material.plate, borderRadius: radius.lg, gap: space[10], padding: space[14] },
  thingHead: { alignItems: "flex-start", flexDirection: "row", gap: space[12] },
  thumb: { borderRadius: radius.sm, height: 40, width: 40 },
  thumbFile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    justifyContent: "center",
  },
  topic: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  topicHead: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  topicTitle: { alignItems: "center", flexDirection: "row", gap: space[6] },
  words: { flex: 1, minWidth: 0 },
});
