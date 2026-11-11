import type { ReactNode } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import type { AttachmentView, StagedAttachmentView } from "./team-models.js";

/**
 * A message's files. Images show the small preview the sender's phone made
 * (a few kilobytes, fine on cellular); the original is fetched only when it is
 * opened. Other files are a card that downloads on tap, never before.
 */
export function MessageAttachments(props: {
  readonly attachments: readonly AttachmentView[];
  readonly onOpen: (attachmentId: string) => void;
}): ReactNode {
  if (props.attachments.length === 0) return null;
  const images = props.attachments.filter((file) => file.kind === "image");
  const files = props.attachments.filter((file) => file.kind !== "image");
  return (
    <View style={styles.attachments}>
      {images.length === 0 ? null : (
        <View style={styles.images}>
          {images.map((image) => (
            <ImagePreview
              image={image}
              key={image.id}
              onOpen={props.onOpen}
              single={images.length === 1}
            />
          ))}
        </View>
      )}
      {files.map((file) => (
        <Pressable
          accessibilityHint="Downloads and opens the file"
          accessibilityLabel={`${file.name}, ${file.size}`}
          accessibilityRole="button"
          key={file.id}
          onPress={() => props.onOpen(file.id)}
          style={({ pressed }) => [styles.file, pressed && styles.filePressed]}
        >
          <View style={styles.fileMark}>
            <Symbol name="doc.text" size={18} tint={color.textSoft} />
          </View>
          <View style={styles.fileText}>
            <AppText numberOfLines={1} role="secondaryMedium">
              {file.name}
            </AppText>
            <AppText role="caption" tone="muted">
              {file.size}
            </AppText>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** One image at its own shape, inside a box a phone column can hold. */
function ImagePreview(props: {
  readonly image: AttachmentView;
  readonly onOpen: (attachmentId: string) => void;
  readonly single: boolean;
}): ReactNode {
  const { image } = props;
  const box = props.single ? { height: 200, width: 260 } : { height: 120, width: 120 };
  const shape = image.preview;
  const fitted =
    shape === null || !props.single ? box : fit(shape.width, shape.height, box.width, box.height);
  return (
    <Pressable
      accessibilityHint="Opens the full image"
      accessibilityLabel={image.name}
      accessibilityRole="imagebutton"
      onPress={() => props.onOpen(image.id)}
      style={({ pressed }) => [styles.image, fitted, pressed && styles.imagePressed]}
    >
      {shape === null ? (
        <View style={styles.imageMissing}>
          <Symbol name="photo" size={22} tint={color.muted} />
        </View>
      ) : (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{ uri: shape.uri }}
          style={StyleSheet.absoluteFill}
        />
      )}
    </Pressable>
  );
}

function fit(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    height: Math.max(48, Math.round(height * scale)),
    width: Math.max(48, Math.round(width * scale)),
  };
}

/**
 * Files waiting in the composer: thumbnails for images, a name for the rest,
 * progress while they upload, and the reason on the chip when one can't go.
 */
export function StagedAttachments(props: {
  readonly files: readonly StagedAttachmentView[];
  readonly onRemove: (attachmentId: string) => void;
}): ReactNode {
  if (props.files.length === 0) return null;
  return (
    <ScrollView
      contentContainerStyle={styles.staged}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
    >
      {props.files.map((file) => (
        <View key={file.id} style={[styles.chip, file.refused !== null && styles.chipRefused]}>
          {file.kind === "image" && file.previewUri !== null ? (
            <Image source={{ uri: file.previewUri }} style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, styles.thumbFile]}>
              <Symbol name="doc.text" size={16} tint={color.textSoft} />
            </View>
          )}
          <View style={styles.chipText}>
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              style={styles.chipName}
            >
              {file.name}
            </AppText>
            {file.refused !== null ? (
              <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="danger">
                {file.refused}
              </AppText>
            ) : file.progress !== null ? (
              <View
                accessibilityLabel={`Uploading, ${Math.round(file.progress * 100)}%`}
                accessibilityRole="progressbar"
                style={styles.track}
              >
                <View style={[styles.progress, { width: `${Math.round(file.progress * 100)}%` }]} />
              </View>
            ) : (
              <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
                Ready
              </AppText>
            )}
          </View>
          <Pressable
            accessibilityLabel={`Remove ${file.name}`}
            accessibilityRole="button"
            hitSlop={space[8]}
            onPress={() => props.onRemove(file.id)}
            style={styles.remove}
          >
            <Symbol name="xmark" size={12} tint={color.muted} weight="semibold" />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  attachments: { gap: space[6], marginTop: space[6] },
  chip: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    height: 52,
    paddingLeft: space[6],
    width: 200,
  },
  chipName: { color: color.text },
  chipRefused: { backgroundColor: color.redWash, borderColor: color.redLine },
  chipText: { flex: 1, gap: 3, minWidth: 0 },
  file: {
    ...material.plate,
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[10],
    maxWidth: 300,
    minHeight: touchTarget + 8,
    paddingHorizontal: space[10],
    paddingVertical: space[8],
  },
  fileMark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  filePressed: { ...material.platePressed },
  fileText: { flexShrink: 1, gap: 1 },
  image: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  imageMissing: { alignItems: "center", flex: 1, justifyContent: "center" },
  imagePressed: { opacity: 0.8 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  progress: { backgroundColor: color.ember, borderRadius: 2, height: 3 },
  remove: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  staged: { gap: space[8], paddingHorizontal: space[12], paddingTop: space[10] },
  thumb: { borderRadius: radius.sm, height: 38, width: 38 },
  thumbFile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    justifyContent: "center",
  },
  track: { backgroundColor: color.lineStrong, borderRadius: 2, height: 3, overflow: "hidden" },
});
