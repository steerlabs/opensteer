import { classifyClientFailure } from "@opensteer/client/connections";
import type { HostClient } from "@opensteer/client/host";
import type { FileResource, FileSource } from "@opensteer/protocol";
import { useEffect, useRef, type ReactNode } from "react";
import { Alert, type StyleProp, type ViewStyle } from "react-native";
import { HoldMenu } from "../thread/hold-menu.js";

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

/** An image already open, read at the revision on screen rather than whatever the path now holds. */
export function openImageSource(
  client: HostClient,
  threadId: string | null,
  file: { readonly resource: FileResource; readonly name: string; readonly mediaType: string },
): ImageActionsSource {
  return {
    name: file.name,
    read: async (signal) => {
      const result = await client.transcriptFiles.download(threadId, file.resource, signal);
      if (result.status !== "ok") throw new Error("This image could not be read.");
      return { bytes: result.bytes, mediaType: file.mediaType };
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
      // The clipboard and share modules load on the first action, never with a transcript.
      const { copyImageBytes, shareFileBytes } = await import("./image-export.js");
      if (id === "share") await shareFileBytes(bytes, source.name, mediaType, signal);
      else await copyImageBytes(bytes, mediaType, signal);
    })()
      .catch((error: unknown) => {
        // A read the connection stopped is said once, by the connection indicator.
        const kind = classifyClientFailure(error).kind;
        if (signal.aborted || kind === "transport" || kind === "service" || kind === "cancelled")
          return;
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
