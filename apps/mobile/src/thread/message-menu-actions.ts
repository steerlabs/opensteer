import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Alert, Share } from "react-native";

/** What a message's menu can do with it, and what it is shown with. */
export interface MessageMenuOptions {
  readonly text: string;
  /** Given, Reply quotes the message into this conversation's composer. */
  readonly onReply?: (() => void) | undefined;
  /** Given, Run details opens what the reply did on the way, in a sheet. */
  readonly onActivity?: (() => void) | undefined;
}

export interface MessageAction {
  readonly id: "activity" | "copy" | "reply" | "share";
  /** The system's own symbol for each; both menus draw SF Symbols by name. */
  readonly image: "arrowshape.turn.up.left" | "doc.on.doc" | "list.bullet" | "square.and.arrow.up";
  readonly title: string;
}

/** Copy and Share need words to act on; Reply and Run details do not. */
export function messageActions(options: MessageMenuOptions): readonly MessageAction[] {
  const worded = options.text !== "";
  return [
    ...(worded ? [{ id: "copy", image: "doc.on.doc", title: "Copy message" } as const] : []),
    ...(options.onReply
      ? [{ id: "reply", image: "arrowshape.turn.up.left", title: "Reply" } as const]
      : []),
    ...(options.onActivity
      ? [{ id: "activity", image: "list.bullet", title: "Run details" } as const]
      : []),
    ...(worded ? [{ id: "share", image: "square.and.arrow.up", title: "Share…" } as const] : []),
  ];
}

export function performMessageAction(actionId: string, options: MessageMenuOptions): void {
  switch (actionId) {
    case "reply":
      options.onReply?.();
      return;
    case "activity":
      options.onActivity?.();
      return;
    case "copy":
    case "share": {
      const action =
        actionId === "copy"
          ? Clipboard.setStringAsync(options.text).then(() => Haptics.selectionAsync())
          : Share.share({ message: options.text });
      void action.catch(() => Alert.alert("Message action unavailable", "Please try again."));
      return;
    }
  }
}
