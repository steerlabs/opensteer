/** What holding a message offers, in the menu's order, and how it is grouped. */
export interface MessageAction {
  readonly group: number;
  readonly id: "activity" | "copy" | "copy-whole" | "reply" | "select" | "share";
  /** The system's own symbol for each; iOS draws SF Symbols by name. */
  readonly image: string;
  readonly title: string;
}

export interface MessageActionOptions {
  /** This bubble is a code block: nothing to select, and its copy says so. */
  readonly code?: boolean | undefined;
  /** Given, Run details opens what the reply did on the way. */
  readonly onActivity?: (() => void) | undefined;
  /** Given, Reply quotes the message into this conversation's composer. */
  readonly onReply?: (() => void) | undefined;
  /** The whole reply this bubble is one part of, where it is only a part. */
  readonly whole?: string | undefined;
  /** It has words to act on; a reply of attachments alone still has Reply and Run Details. */
  readonly worded?: boolean | undefined;
}

export function messageActions(options: MessageActionOptions): readonly MessageAction[] {
  const wordless = options.worded === false;
  return [
    ...(options.onReply === undefined
      ? []
      : [{ group: 0, id: "reply", image: "arrowshape.turn.up.left", title: "Reply" } as const]),
    ...(wordless
      ? []
      : [
          {
            group: 1,
            id: "copy",
            image: "doc.on.doc",
            title: options.code === true ? "Copy Code" : "Copy",
          } as const,
        ]),
    ...(options.whole === undefined
      ? []
      : [
          {
            group: 1,
            id: "copy-whole",
            image: "doc.on.clipboard",
            title: "Copy Whole Reply",
          } as const,
        ]),
    ...(wordless || options.code === true
      ? []
      : [{ group: 1, id: "select", image: "selection.pin.in.out", title: "Select" } as const]),
    ...(wordless
      ? []
      : [{ group: 1, id: "share", image: "square.and.arrow.up", title: "Share…" } as const]),
    ...(options.onActivity === undefined
      ? []
      : [{ group: 2, id: "activity", image: "list.bullet", title: "Run Details" } as const]),
  ];
}
