import type { z } from "zod";
import {
  attachmentNativeImageMediaTypes,
  type ArtifactContentPart,
  type Attachment,
  type ContentPart,
  type ContentPartSchema,
} from "@opensteer/core";
import { formatBytes } from "../../app-model.js";

const inlineImageTypes: ReadonlySet<string> = new Set(attachmentNativeImageMediaTypes);

/**
 * Only the raster types every engine reads natively are drawn in an `<img>`.
 * Anything else, SVG included, stays a file: its bytes are the person's to
 * download, not the page's to interpret.
 */
export function isInlineImage(mediaType: string): boolean {
  return inlineImageTypes.has(mediaType.toLowerCase());
}

export function artifactPart(attachment: Attachment): ArtifactContentPart {
  return {
    artifactId: attachment.id,
    mediaType: attachment.mediaType,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    type: "artifact",
  };
}

/** A part as a command carries it, before the Host has read its identifiers. */
export type SentContentPart = ContentPart | z.input<typeof ContentPartSchema>;

export function artifactParts(content: readonly SentContentPart[]): ArtifactContentPart[] {
  return content.flatMap((part) => (part.type === "artifact" ? [part] : []));
}

/** The words a person wrote, without the attachments that travel beside them. */
export function messageText(content: readonly SentContentPart[]): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/** "PNG · 1.2 MB": the kind a person recognises, from the name before the media type. */
export function attachmentDetail(name: string, mediaType: string, sizeBytes?: number): string {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(name)?.[1];
  const subtype = mediaType.split("/")[1]?.split(/[+;]/u)[0];
  const kind = (
    extension ?? (subtype && subtype !== "octet-stream" ? subtype : "file")
  ).toUpperCase();
  return sizeBytes === undefined ? kind : `${kind} · ${formatBytes(sizeBytes)}`;
}
