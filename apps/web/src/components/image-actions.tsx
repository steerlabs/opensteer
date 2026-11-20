import { fileDeviceUpdateMessage } from "@opensteer/client/host";
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { HostClient } from "@opensteer/client/host";
import type { ThreadId } from "@opensteer/core";
import type { FileResource, FileSource } from "@opensteer/protocol";
import { canCopyImages, copyImage, saveFile } from "./file-actions.js";
import { Popover } from "./popover.js";
import { useToast } from "./toast.js";

/** Reads an image's original, only once an action asks for it. */
export type ImageRead = () => Promise<File>;

/** Why an original couldn't be read, in words a person can act on. */
export class ImageUnavailableError extends Error {}

/** A transcript image's original, read through the Host, which alone decides who may. */
export function transcriptImageRead(
  client: HostClient,
  threadId: string | null,
  source: FileSource,
): ImageRead {
  return async () => {
    const original = await client.transcriptFiles.original(threadId, source);
    if (original.status !== "ok") throw unavailable(original.status);
    return imageFile(original.bytes, original.name, original.mediaType);
  };
}

/** The same, for a file already open, whose revision is known. */
export function openImageRead(
  client: HostClient,
  threadId: ThreadId | null,
  file: { readonly resource: FileResource; readonly name: string; readonly mediaType: string },
): ImageRead {
  return async () => {
    const content = await client.transcriptFiles.download(threadId, file.resource);
    if (content.status !== "ok") throw unavailable(content.status);
    return imageFile(content.bytes, file.name, file.mediaType);
  };
}

function imageFile(bytes: Uint8Array, name: string, mediaType: string): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], fileName(name), { type: mediaType });
}

function unavailable(
  status: "unavailable" | "unreachable" | "failed" | "update-required",
): ImageUnavailableError {
  if (status === "update-required") return new ImageUnavailableError(fileDeviceUpdateMessage);
  return new ImageUnavailableError(
    // Offline is the pill's to say; the image says only that it couldn't be read.
    status === "unavailable" ? "This image isn't available anymore." : "Couldn't read this image.",
  );
}

function fileName(name: string): string {
  return name.split(/[\\/]/u).at(-1) || name;
}

export interface ImageActions {
  /** Absent where the page has no clipboard to write images to. */
  readonly copy: (() => void) | null;
  readonly download: () => void;
  /** Spread onto the element the image is shown in. */
  readonly target: {
    readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  readonly menu: ReactNode;
}

/**
 * The same two things to do with every image a person is shown: copy it and
 * download it, from a right-click or the keyboard's menu key, and from the
 * viewer's own buttons. Each acts on the original, not the preview on screen.
 */
export function useImageActions(read: ImageRead | null): ImageActions {
  const toast = useToast();
  const [menu, setMenu] = useState<{
    readonly anchor: HTMLElement;
    readonly at: { readonly x: number; readonly y: number };
  } | null>(null);
  const failed = (fallback: string) => (error: unknown) =>
    toast.error(error instanceof ImageUnavailableError ? error.message : fallback);
  const copy =
    read && canCopyImages()
      ? () => {
          void copyImage(read).then(
            () => toast.success("Image copied"),
            failed("Couldn't copy this image."),
          );
        }
      : null;
  const download = () => {
    if (!read) return;
    void read().then((file) => saveFile(file, file.name), failed("Couldn't download this image."));
  };
  const choose = (action: () => void) => () => {
    setMenu(null);
    action();
  };
  return {
    copy,
    download,
    target: {
      onContextMenu: (event) => {
        if (!read) return;
        event.preventDefault();
        setMenu({ anchor: event.currentTarget, at: { x: event.clientX, y: event.clientY } });
      },
      onKeyDown: (event) => {
        if (!read || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)))
          return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        setMenu({ anchor: event.currentTarget, at: { x: box.left, y: box.bottom } });
      },
    },
    menu: menu ? (
      <Popover
        anchor={menu.anchor}
        at={menu.at}
        label="Image actions"
        onClose={() => setMenu(null)}
      >
        {copy ? (
          <button className="picker__row" onClick={choose(copy)} role="menuitem" type="button">
            Copy image
          </button>
        ) : null}
        <button className="picker__row" onClick={choose(download)} role="menuitem" type="button">
          Download
        </button>
      </Popover>
    ) : null,
  };
}
