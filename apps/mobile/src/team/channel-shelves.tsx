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
import { AppText, RowGroup } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { MessageBody } from "./message-body.js";
import { Avatar } from "./team-marks.js";
import type { FileRowView, MessageView } from "./team-models.js";

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
              accessibilityLabel={`${file.attachment.name}, ${file.attachment.size}`}
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
                  {file.attachment.size}
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
  readonly pins: readonly MessageView[];
  readonly onShow: (messageId: string) => void;
  readonly onUnpin: (messageId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  if (props.pins.length === 0) {
    return <Empty text="Pin a message to keep it here. Hold any message, then Pin." />;
  }
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      {props.pins.map((message) => {
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
              <Symbol accessibilityLabel="Pinned" name="pin" size={12} tint={color.amber} />
              <View style={styles.grow} />
              <TextButton label="View in channel" onPress={() => props.onShow(message.id)} />
              <TextButton label="Unpin" onPress={() => props.onUnpin(message.id)} />
            </View>
          </View>
        );
      })}
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
  empty: { alignItems: "center", padding: space[32] },
  emptyText: { textAlign: "center" },
  fileRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 12,
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
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
  pinFoot: { alignItems: "center", flexDirection: "row", gap: space[12] },
  pinHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
  pinName: { flexShrink: 1, fontWeight: "600" },
  pressed: { backgroundColor: color.surfacePressed },
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
  textButton: { color: color.ember, fontWeight: "600" },
  thumb: { borderRadius: radius.sm, height: 40, width: 40 },
  thumbFile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    justifyContent: "center",
  },
  words: { flex: 1, minWidth: 0 },
});
