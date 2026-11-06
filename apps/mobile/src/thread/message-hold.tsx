import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, Share, Text, type StyleProp, type ViewStyle } from "react-native";
import { contactSupport } from "../report-mail.js";
import { color, type } from "../theme.js";
import { Sheet } from "../ui/sheet.js";
import { HoldMenu } from "./hold-menu.js";
import {
  messageActions,
  type MessageAction,
  type MessageActionOptions,
} from "./message-actions.js";
import { MessageMenu } from "./message-menu.js";

type MessageOptions = MessageActionOptions & {
  /** What this message holds: what Copy, Select and Share take. */
  readonly text: string;
};

function useMessageActions(options: MessageOptions): {
  readonly act: (id: string) => void;
  readonly actions: readonly MessageAction[];
  readonly selecting: boolean;
  readonly stopSelecting: () => void;
} {
  const { code, onActivity, onReply, reportId, selectable, text, whole } = options;
  const [selecting, setSelecting] = useState(false);
  const worded = text !== "";
  const actions = useMemo(
    () => messageActions({ code, onActivity, onReply, reportId, selectable, whole, worded }),
    [code, onActivity, onReply, reportId, selectable, whole, worded],
  );
  const act = useCallback(
    (id: string): void => {
      switch (id) {
        case "reply":
          onReply?.();
          return;
        case "activity":
          onActivity?.();
          return;
        case "report":
          if (reportId !== undefined) contactSupport({ kind: "reply", id: reportId });
          return;
        case "select":
          setSelecting(true);
          return;
        case "copy":
        case "copy-whole":
          void Clipboard.setStringAsync(id === "copy" ? text : (whole ?? text)).then(
            () => Haptics.selectionAsync(),
            () => Alert.alert("Copy unavailable", "Select the text to copy it."),
          );
          return;
        case "share":
          void Share.share({ message: text }).catch(() =>
            Alert.alert("Share unavailable", "Copy the text instead."),
          );
          return;
      }
    },
    [onActivity, onReply, reportId, text, whole],
  );
  return { act, actions, selecting, stopSelecting: () => setSelecting(false) };
}

/**
 * A message a person holds to act on. Holding is how a bubble is copied, as in
 * Messages, so a bubble's words cannot also be selectable: the system's own
 * selection would answer the same hold. Select opens them where they can be.
 */
export function MessageHold(
  props: MessageOptions & {
    readonly children: ReactNode;
    readonly previewRadius: number;
    readonly previewBottomEndRadius?: number | undefined;
    readonly style?: StyleProp<ViewStyle>;
  },
): ReactNode {
  const { act, actions, selecting, stopSelecting } = useMessageActions(props);
  return (
    <>
      <HoldMenu
        actions={actions}
        onAction={act}
        previewBottomEndRadius={props.previewBottomEndRadius}
        previewRadius={props.previewRadius}
        style={props.style}
      >
        {props.children}
      </HoldMenu>
      {selecting ? (
        <Sheet onClose={stopSelecting} open title="Select text">
          <Text selectable style={{ ...type.reading, color: color.text }}>
            {props.text}
          </Text>
        </Sheet>
      ) : null}
    </>
  );
}

/** The same actions under a task's words, which a hold has to leave free to select. */
export function MessageMore(props: {
  readonly reportId: string;
  readonly text: string;
}): ReactNode {
  const { act, actions } = useMessageActions({ ...props, selectable: true });
  return <MessageMenu actions={actions} onAction={act} />;
}
