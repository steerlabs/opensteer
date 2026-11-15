import { classifyHref, type ReferenceKind, type TeamPageTarget } from "@opensteer/core";

/**
 * The picture each thing a chip names wears, on every client. Each client
 * draws a name in its own hand: web's icon set, SF Symbols on iOS, and the
 * same strokes as web on Android.
 */
export type ReferenceIconName =
  | "bubble"
  | "activity"
  | "hand"
  | "quote"
  | "clock"
  | "desktop"
  | "paperclip"
  | "file"
  | "image"
  | "hash"
  | "reply"
  | "folder"
  | "note"
  | "people"
  | "link";

const referenceIcons: Readonly<Record<ReferenceKind, ReferenceIconName>> = {
  task: "bubble",
  run: "activity",
  request: "hand",
  message: "quote",
  automation: "clock",
  computer: "desktop",
  attachment: "paperclip",
};

const teamPageIcons: Readonly<Record<TeamPageTarget["kind"], ReferenceIconName>> = {
  invite: "people",
  channel: "hash",
  message: "quote",
  thread: "reply",
  "knowledge-topic": "folder",
  "knowledge-note": "note",
};

const imagePath = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/iu;

export function referenceIcon(kind: ReferenceKind): ReferenceIconName {
  return referenceIcons[kind];
}

export function teamPageIcon(kind: TeamPageTarget["kind"]): ReferenceIconName {
  return teamPageIcons[kind];
}

export function fileIcon(path: string): ReferenceIconName {
  return imagePath.test(path) ? "image" : "file";
}

/** The icon for wherever a link goes; anything that is not a chip is a link. */
export function hrefIcon(href: string): ReferenceIconName {
  const target = classifyHref(href);
  switch (target.kind) {
    case "reference":
      return referenceIcons[target.reference.kind];
    case "team-page":
      return teamPageIcons[target.page.target.kind];
    case "file":
      return fileIcon(target.file.path);
    default:
      return "link";
  }
}
