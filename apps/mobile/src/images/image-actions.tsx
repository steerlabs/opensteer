import type { HostClient } from "@opensteer/client/host";
import type { FileSource } from "@opensteer/protocol";
import { encodeBase64 } from "@opensteer/shared/base64url";
import * as Clipboard from "expo-clipboard";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useEffect, useRef, type ReactNode } from "react";
import { Alert, Platform, type StyleProp, type ViewStyle } from "react-native";
import { shareFileBytes } from "../platform/share-file-bytes.js";
import { HoldMenu } from "../thread/hold-menu.js";
import { clipboardNeedsPng } from "./clipboard-format.js";

export interface ImageActionsSource {
  readonly signal?: AbortSignal | undefined;
  readonly name: string;
  readonly read: (signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export function personalImageSource(
  client: HostClient,
  threadId: string | null,
  source: FileSource,
  name: string,
): ImageActionsSource {
  return {
    name,
    read: async (signal) => {
      const result = await client.transcriptFiles.original(threadId, source, signal);
      if (result.status !== "ok") throw new Error("This image could not be read.");
      return result;
    },
  };
}

const actions = [
  { group: 0, id: "copy", image: "doc.on.doc", title: "Copy" },
  { group: 0, id: "share", image: "square.and.arrow.up", title: "Share" },
];

export function useImageActions(source: ImageActionsSource) {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const act = (id: string) => {
    if ((id !== "copy" && id !== "share") || pending.current !== null) return;
    const controller = new AbortController();
    pending.current = controller;
    const signal = source.signal
      ? AbortSignal.any([source.signal, controller.signal])
      : controller.signal;
    void (async () => {
      const { bytes, mediaType } = await source.read(signal);
      signal.throwIfAborted();
      if (id === "share") {
        await shareFileBytes(bytes, source.name, mediaType, signal);
        return;
      }
      let base64 = encodeBase64(bytes);
      if (!clipboardNeedsPng(mediaType, Platform.OS)) {
        try {
          await Clipboard.setImageAsync(base64);
          void Haptics.selectionAsync();
          return;
        } catch {
          signal.throwIfAborted();
        }
      }
      const context = ImageManipulator.manipulate(`data:${mediaType};base64,${base64}`);
      let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
      let output: File | undefined;
      try {
        rendered = await context.renderAsync();
        const result = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
        output = new File(result.uri);
        if (!result.base64) throw new Error("Image conversion failed.");
        base64 = result.base64;
      } finally {
        if (output?.exists) output.delete();
        rendered?.release();
        context.release();
      }
      signal.throwIfAborted();
      await Clipboard.setImageAsync(base64);
      void Haptics.selectionAsync();
    })()
      .catch(() => {
        if (!signal.aborted)
          Alert.alert(
            id === "copy" ? "Copy unavailable" : "Share unavailable",
            "This image could not be read. Try again.",
          );
      })
      .finally(() => {
        if (pending.current === controller) pending.current = null;
      });
  };
  return { act, actions };
}

export function ImageHold(props: {
  readonly source: ImageActionsSource;
  readonly children: ReactNode;
  readonly shareOnPress?: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { act } = useImageActions(props.source);
  return (
    <HoldMenu
      actions={actions}
      onAction={act}
      onPress={props.shareOnPress ? () => act("share") : props.onPress}
      accessibilityLabel={props.source.name}
      previewRadius={0}
      style={props.style}
    >
      {props.children}
    </HoldMenu>
  );
}
