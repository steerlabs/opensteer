import type { HostClient, TranscriptFileState } from "@opensteer/client/host";
import { TranscriptImageContext, useAssetImage } from "@opensteer/client/react";
import type { FileSource } from "@opensteer/protocol";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  FlatList,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ImageHold,
  openImageSource,
  personalImageSource,
  useImageActions,
  type ImageActionsSource,
} from "../images/image-actions.js";
import { shareFileBytes } from "../platform/attachment-draft-files.js";
import { DeploymentGate, useAttachedHost } from "../screens/deployment-gate.js";
import { color, radius, space, type } from "../theme.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, monoFontFamily, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { UnavailableState } from "../ui/unavailable-state.js";

export type FileViewerParams = {
  readonly deploymentId: string;
  /** The conversation whose words named the file; null outside one. */
  readonly threadId: string | null;
  readonly source: FileSource;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly endLine?: number | undefined;
};

/**
 * A file an agent or a person linked, read through the Host, which alone
 * decides whether it may be shown. Text opens at the line the link named;
 * an image fits the screen with its original a tap away; anything else can be
 * downloaded. Nothing here reaches a path on its own.
 */
export function FileViewerScreen(props: StaticScreenProps<FileViewerParams>): ReactNode {
  const params = props.route.params;
  const client = useAttachedHost(params.deploymentId);
  if (client === null) return <DeploymentGate deploymentId={params.deploymentId} />;
  return (
    <FileView
      client={client}
      key={`${params.deploymentId}:${JSON.stringify(params.source)}`}
      params={params}
    />
  );
}

type Shown = TranscriptFileState | { readonly status: "loading" };

function FileView(props: { readonly client: HostClient; readonly params: FileViewerParams }) {
  const { client, params } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState<Shown>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const source = params.source;
  useEffect(() => {
    const controller = new AbortController();
    setShown({ status: "loading" });
    client.transcriptFiles.open(params.threadId, source, controller.signal).then(
      (state) => {
        if (!controller.signal.aborted) setShown(state);
      },
      () => {
        if (!controller.signal.aborted) setShown({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [attempt, client, params.threadId, source]);
  const file = shown.status === "ok" ? shown : shown.status === "offline" ? shown.cached : null;
  const path = source.kind === "path" ? source.path : null;
  const name = file?.name ?? baseName(path) ?? "Attachment";
  const imageSource =
    file === null
      ? personalImageSource(client, params.threadId, source, name)
      : openImageSource(client, params.threadId, { ...file, name });
  const imageActions = useImageActions(imageSource);
  const folder = path === null ? null : path.slice(0, Math.max(0, path.length - name.length - 1));
  const retry = () => setAttempt((count) => count + 1);
  const download =
    file === null
      ? null
      : file.preview.kind === "image"
        ? () => imageActions.act("share")
        : () => {
            setSaving(true);
            void client.transcriptFiles
              .download(params.threadId, file.resource)
              .then(async (result) => {
                if (result.status === "ok")
                  await shareFileBytes(result.bytes, file.name, result.metadata.contentType);
                else if (result.status === "unavailable") setShown({ status: "unavailable" });
                else Alert.alert("Couldn't download this", "Try again.");
              })
              .catch(() => Alert.alert("Couldn't download this", "Try again."))
              .finally(() => setSaving(false));
          };
  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <View style={[styles.header, { paddingTop: insets.top + space[8] }]}>
        <Symbol
          name={file?.preview.kind === "image" ? "photo" : "doc"}
          size={18}
          tint={color.muted}
        />
        <View style={styles.titles}>
          <AppText numberOfLines={1} role="secondaryMedium">
            {name}
          </AppText>
          {folder ? (
            // The folder's start and its last name say where the file is; the middle gives way.
            <Text ellipsizeMode="middle" numberOfLines={1} style={styles.folder}>
              {folder}
            </Text>
          ) : null}
        </View>
        {file?.preview.kind === "image" ? (
          <HeaderAction
            icon="square.on.square"
            label="Copy"
            onPress={() => imageActions.act("copy")}
          />
        ) : null}
        {download ? (
          <HeaderAction
            disabled={saving}
            icon="square.and.arrow.up"
            label="Share"
            onPress={download}
          />
        ) : null}
        <HeaderAction icon="xmark" label="Close" onPress={() => navigation.goBack()} />
      </View>
      {shown.status === "loading" ? (
        <Skeleton />
      ) : shown.status === "unavailable" ? (
        <UnavailableState onBack={() => navigation.goBack()} />
      ) : shown.status === "failed" || (shown.status === "offline" && file === null) ? (
        <UnavailableState onBack={() => navigation.goBack()} onRetry={retry} />
      ) : file === null ? null : file.preview.kind === "text" ? (
        <>
          {shown.status === "offline" ? (
            <Banner
              action={{ label: "Retry", onPress: retry }}
              text="Offline. Showing a saved copy."
            />
          ) : null}
          {file.preview.truncated ? (
            <Banner text="Only the start of this file is shown. Share it to see all of it." />
          ) : null}
          <TextLines
            endLine={params.endLine ?? params.line ?? null}
            line={params.line ?? null}
            text={file.preview.text}
          />
        </>
      ) : file.preview.kind === "image" ? (
        <TranscriptImageContext value={{ client, threadId: params.threadId }}>
          <ImageSurface
            actionsSource={imageSource}
            name={file.name}
            onStale={retry}
            revision={file.resource.revision}
            source={source}
          />
        </TranscriptImageContext>
      ) : (
        <View style={styles.download}>
          <Symbol name="doc" size={40} tint={color.muted} />
          <AppText role="secondary" tone="muted">
            {`${file.mediaType} · ${byteSize(file.sizeBytes)}`}
          </AppText>
          {download ? (
            <SecondaryButton busy={saving} compact label="Share" onPress={download} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function HeaderAction(props: {
  readonly disabled?: boolean;
  readonly icon: "square.and.arrow.up" | "xmark" | "square.on.square";
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
    >
      <Symbol name={props.icon} size={17} tint={color.textSoft} />
    </Pressable>
  );
}

function Banner(props: {
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly text: string;
}): ReactNode {
  return (
    <View style={styles.banner}>
      <AppText role="caption" style={styles.bannerText} tone="soft">
        {props.text}
      </AppText>
      {props.action ? (
        <Pressable accessibilityRole="button" onPress={props.action.onPress}>
          <AppText role="caption" tone="ember">
            {props.action.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Lines past this run past the screen anyway; a minified file still opens. */
const widestLine = 2_000;
const codeSize = 13;
const codeLineHeight = 19;

/**
 * Numbered lines, drawn only as they scroll into view. The linked line is
 * washed in the accent and stands a third of the way down; long lines scroll
 * sideways together rather than wrapping out of their numbers.
 */
function TextLines(props: {
  readonly endLine: number | null;
  readonly line: number | null;
  readonly text: string;
}): ReactNode {
  const lines = useMemo(() => props.text.split(/\r\n|\r|\n/u), [props.text]);
  const scale = PixelRatio.getFontScale();
  const rowHeight = Math.ceil(codeLineHeight * scale);
  const charWidth = codeSize * 0.62 * scale;
  const gutter = Math.ceil(String(lines.length).length * charWidth + space[16]);
  const longest = useMemo(
    () =>
      Math.min(
        widestLine,
        lines.reduce((most, line) => Math.max(most, line.length), 0),
      ),
    [lines],
  );
  // A line past what loaded is never stood in for by another: say so and show the end.
  const outside = props.line !== null && props.line > lines.length;
  const target = props.line === null || outside ? null : Math.max(props.line, 1);
  const end =
    target === null ? null : Math.max(target, Math.min(props.endLine ?? target, lines.length));
  const list = useRef<FlatList<string>>(null);
  const [height, setHeight] = useState(0);
  const visibleRows = Math.floor(height / rowHeight);
  const initial = outside
    ? Math.max(0, lines.length - visibleRows)
    : target === null
      ? 0
      : Math.max(0, target - 1 - Math.floor(visibleRows / 3));
  return (
    <>
      {outside ? <Banner text={`Line ${props.line} isn't in what loaded here.`} /> : null}
      <ScrollView
        directionalLockEnabled
        horizontal
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={styles.lines}
      >
        {height === 0 ? null : (
          <FlatList
            data={lines}
            getItemLayout={(_, index) => ({ index, length: rowHeight, offset: rowHeight * index })}
            initialNumToRender={Math.ceil(height / rowHeight) + 4}
            initialScrollIndex={Math.min(initial, Math.max(0, lines.length - 1))}
            keyExtractor={(_, index) => String(index)}
            ref={list}
            renderItem={({ index, item }) => {
              const number = index + 1;
              const marked = target !== null && end !== null && number >= target && number <= end;
              return (
                <View
                  accessibilityLabel={marked ? `Line ${number}, linked` : undefined}
                  style={[styles.row, { height: rowHeight }, marked && styles.marked]}
                >
                  <Text style={[styles.number, { width: gutter }]}>{number}</Text>
                  <Text numberOfLines={1} selectable style={styles.code}>
                    {item.length > widestLine ? `${item.slice(0, widestLine)}…` : item}
                  </Text>
                </View>
              );
            }}
            style={{ width: gutter + longest * charWidth + space[24] }}
            windowSize={7}
          />
        )}
      </ScrollView>
    </>
  );
}

/**
 * An image fit to the screen, from the preview its open minted; Original fetches its full
 * size only when asked. A later mint naming another revision opens the file again, so
 * Download stays on what is shown.
 */
function ImageSurface(props: {
  readonly actionsSource: ImageActionsSource;
  readonly name: string;
  readonly onStale: () => void;
  readonly revision: string;
  readonly source: FileSource;
}): ReactNode {
  const [variant, setVariant] = useState<"preview" | "original">("preview");
  const image = useAssetImage(props.source, variant);
  const stale = image.image !== null && image.image.revision !== props.revision;
  const { onStale } = props;
  useEffect(() => {
    if (stale) onStale();
  }, [stale]);
  return (
    <View style={styles.imageSurface}>
      {image.failed ? (
        <AppText role="secondary" tone="muted">
          This image couldn't be shown.
        </AppText>
      ) : (
        <ScrollView
          centerContent
          contentContainerStyle={styles.imageContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
        >
          <ImageHold source={props.actionsSource} style={{ flex: 1 }}>
            <Image
              accessibilityLabel={props.name}
              cachePolicy="memory-disk"
              contentFit="contain"
              key={image.retry}
              onError={image.onError}
              source={
                image.image && !stale
                  ? {
                      cacheKey: `${image.deploymentId}:${image.image.revision}:${variant}:v1`,
                      uri: image.image.source,
                    }
                  : null
              }
              style={styles.image}
            />
          </ImageHold>
        </ScrollView>
      )}
      {variant === "preview" ? (
        <View style={styles.imageActions}>
          <SecondaryButton compact label="Original" onPress={() => setVariant("original")} />
        </View>
      ) : null}
    </View>
  );
}

function Skeleton(): ReactNode {
  return (
    <View accessibilityLabel="Loading" style={styles.skeleton}>
      {[0.82, 0.64, 0.9, 0.48, 0.74, 0.58].map((width, index) => (
        <View key={index} style={[styles.skeletonLine, { width: `${width * 100}%` }]} />
      ))}
    </View>
  );
}

function baseName(path: string | null): string | null {
  return path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
}

function byteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    flexDirection: "row",
    gap: space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[8],
  },
  bannerText: { flex: 1 },
  code: {
    color: color.text,
    fontFamily: monoFontFamily,
    fontSize: codeSize,
    lineHeight: codeLineHeight,
  },
  download: { alignItems: "center", flex: 1, gap: space[12], justifyContent: "center" },
  folder: { ...type.caption, color: color.muted },
  header: {
    alignItems: "center",
    borderBottomColor: color.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[10],
    paddingBottom: space[10],
    paddingHorizontal: space[16],
  },
  headerAction: {
    alignItems: "center",
    borderRadius: radius.full,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  image: { flex: 1, minHeight: 240, width: "100%" },
  imageActions: { alignItems: "center", paddingVertical: space[12] },
  imageContent: { flexGrow: 1 },
  imageSurface: { flex: 1 },
  lines: { flex: 1 },
  marked: { backgroundColor: color.emberWash },
  number: {
    color: color.mutedDim,
    fontFamily: monoFontFamily,
    fontSize: codeSize,
    lineHeight: codeLineHeight,
    paddingRight: space[12],
    textAlign: "right",
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: { alignItems: "center", flexDirection: "row", paddingRight: space[24] },
  screen: { backgroundColor: color.background, flex: 1 },
  skeleton: { gap: space[10], padding: space[16] },
  skeletonLine: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xs,
    height: type.caption.lineHeight - 4,
  },
  titles: { flex: 1, gap: 2 },
});
