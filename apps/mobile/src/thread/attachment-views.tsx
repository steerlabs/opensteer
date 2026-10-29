import type { HostClient } from "@opensteer/client/host";
import { attachmentNativeImageMediaTypes, type ArtifactContentPart } from "@opensteer/core";
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { shareChatAttachment } from "../platform/attachment-draft-files.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { attachmentKey, type ComposerAttachment } from "./draft-attachments.js";

/**
 * The Thread's own client, which a transcript's rows read the files messages
 * carry through on demand. Without one the files are named but cannot be opened.
 */
export const AttachmentReader = createContext<HostClient | null>(null);

const inlineImageTypes: ReadonlySet<string> = new Set(attachmentNativeImageMediaTypes);

/**
 * The files on the draft, above the bar. A picked photo shows from this
 * phone's own copy; every chip says where its upload stands and can be taken
 * off, and one that failed says why and offers another try when one can help.
 */
export function AttachmentStrip(props: {
  readonly disabled: boolean;
  readonly items: readonly ComposerAttachment[];
  readonly notice: string | null;
  readonly onRemove: (key: string) => void;
  readonly onRetry: (key: string) => void;
}): ReactNode {
  if (props.items.length === 0 && props.notice === null) return null;
  return (
    <View style={styles.strip}>
      {props.items.length > 0 ? (
        <ScrollView
          accessibilityLabel="Attachments"
          contentContainerStyle={styles.stripContent}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {props.items.map((item) => (
            <StagedChip
              disabled={props.disabled}
              item={item}
              key={attachmentKey(item)}
              onRemove={props.onRemove}
              onRetry={props.onRetry}
            />
          ))}
        </ScrollView>
      ) : null}
      {props.notice === null ? null : (
        <AppText accessibilityLabel={props.notice} role="caption" tone="danger">
          {props.notice}
        </AppText>
      )}
    </View>
  );
}

function StagedChip(props: {
  readonly disabled: boolean;
  readonly item: ComposerAttachment;
  readonly onRemove: (key: string) => void;
  readonly onRetry: (key: string) => void;
}): ReactNode {
  const { item } = props;
  const key = attachmentKey(item);
  const failed = item.status === "error";
  const busy = item.status === "staged" || item.status === "uploading";
  // A file the Host already holds is only confirmed, never sent again.
  const detail = busy
    ? item.localUri === null
      ? "Checking…"
      : "Uploading…"
    : failed
      ? (item.error ?? "Could not be attached.")
      : attachmentDetail(item.name, item.mediaType, item.sizeBytes);
  return (
    <View
      accessibilityLabel={`${item.name}, ${detail}`}
      accessibilityState={{ busy }}
      style={[styles.chip, failed && styles.chipFailed]}
    >
      <View style={styles.media}>
        {item.localUri !== null && inlineImageTypes.has(item.mediaType.toLowerCase()) ? (
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: item.localUri }}
            style={styles.thumbnail}
          />
        ) : (
          <Symbol name="doc.text" size={16} tint={color.muted} />
        )}
        {busy ? (
          <View style={styles.mediaOverlay}>
            <ActivityIndicator color={color.text} size="small" />
          </View>
        ) : null}
      </View>
      <View style={styles.chipText}>
        <AppText numberOfLines={1} role="caption">
          {item.name}
        </AppText>
        <AppText numberOfLines={2} role="caption" tone={failed ? "danger" : "muted"}>
          {detail}
        </AppText>
      </View>
      {failed && item.retryable ? (
        <Pressable
          accessibilityLabel={`Retry uploading ${item.name}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled }}
          disabled={props.disabled}
          hitSlop={space[6]}
          onPress={() => props.onRetry(key)}
          style={[styles.chipAction, props.disabled && styles.disabled]}
        >
          <AppText role="caption" tone="ember">
            Retry
          </AppText>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel={`Remove ${item.name}`}
        accessibilityRole="button"
        hitSlop={space[6]}
        onPress={() => props.onRemove(key)}
        style={styles.chipAction}
      >
        <Symbol name="xmark" size={12} tint={color.muted} />
      </Pressable>
    </View>
  );
}

/**
 * The files a sent message carries, in the order they were sent. Opening one
 * reads the Host's original and hands it to the system share sheet, which
 * previews what it can and saves the rest.
 */
export function MessageAttachments(props: {
  readonly attachments: readonly ArtifactContentPart[];
}): ReactNode {
  const client = useContext(AttachmentReader);
  if (props.attachments.length === 0) return null;
  return (
    <View style={styles.sent}>
      {props.attachments.map((part) => (
        <SentChip client={client} key={part.artifactId} part={part} />
      ))}
    </View>
  );
}

function SentChip(props: {
  readonly client: HostClient | null;
  readonly part: ArtifactContentPart;
}): ReactNode {
  const { client, part } = props;
  const [opening, setOpening] = useState(false);
  const detail = attachmentDetail(part.name, part.mediaType, part.sizeBytes);
  const face = (
    <>
      <Symbol name="doc.text" size={16} tint={color.muted} />
      <View style={styles.chipText}>
        <AppText numberOfLines={1} role="secondary">
          {part.name}
        </AppText>
        <AppText role="caption" tone="muted">
          {detail}
        </AppText>
      </View>
      {opening ? <ActivityIndicator color={color.muted} size="small" /> : null}
    </>
  );
  if (client === null) {
    return (
      <View accessibilityLabel={`${part.name}, ${detail}`} style={styles.sentChip}>
        {face}
      </View>
    );
  }
  const open = () => {
    setOpening(true);
    void shareChatAttachment(client, part.artifactId, part.name)
      .catch((error: unknown) =>
        Alert.alert(
          "Attachment not opened",
          operationDetail(error, "This attachment could not be read."),
        ),
      )
      .finally(() => setOpening(false));
  };
  return (
    <Pressable
      accessibilityHint="Opens it to view or save"
      accessibilityLabel={`${part.name}, ${detail}`}
      accessibilityRole="button"
      accessibilityState={{ busy: opening, disabled: opening }}
      disabled={opening}
      onPress={open}
      style={({ pressed }) => [styles.sentChip, pressed && styles.pressed]}
    >
      {face}
    </Pressable>
  );
}

/** "PNG · 1.2 MB": the kind a person recognises, from the name before the media type. */
function attachmentDetail(name: string, mediaType: string, sizeBytes?: number): string {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(name)?.[1];
  const subtype = mediaType.split("/")[1]?.split(/[+;]/u)[0];
  const kind = (
    extension ?? (subtype && subtype !== "octet-stream" ? subtype : "file")
  ).toUpperCase();
  if (sizeBytes === undefined) return kind;
  const size =
    sizeBytes < 1_024
      ? `${sizeBytes} B`
      : sizeBytes < 1_048_576
        ? `${Math.round(sizeBytes / 1_024)} KB`
        : `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
  return `${kind} · ${size}`;
}

const styles = StyleSheet.create({
  chip: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    padding: space[4],
    width: 220,
  },
  chipAction: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 32,
    minWidth: 32,
  },
  chipFailed: { backgroundColor: color.redWash, borderColor: color.redLine },
  chipText: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.45 },
  media: {
    alignItems: "center",
    backgroundColor: color.surfacePressed,
    borderRadius: radius.xs,
    height: 40,
    justifyContent: "center",
    overflow: "hidden",
    width: 40,
  },
  mediaOverlay: {
    alignItems: "center",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    justifyContent: "center",
  },
  pressed: { backgroundColor: color.surfacePressed },
  sent: { alignItems: "flex-end", gap: space[6] },
  sentChip: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[10],
    maxWidth: "100%",
    minHeight: touchTarget,
    paddingHorizontal: space[10],
    paddingVertical: space[6],
    width: 260,
  },
  strip: { gap: space[6] },
  stripContent: { gap: space[8] },
  thumbnail: { height: 40, width: 40 },
});
