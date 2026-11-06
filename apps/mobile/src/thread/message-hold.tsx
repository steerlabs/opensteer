import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, Share, Text, type StyleProp, type ViewStyle } from "react-native";
import { color, type } from "../theme.js";
import { Sheet } from "../ui/sheet.js";
import { HoldMenu } from "./hold-menu.js";
import { messageActions, type MessageActionOptions } from "./message-actions.js";

/**
 * A message a person holds to act on. Holding is how a bubble is copied, as in
 * Messages, so a bubble's words cannot also be selectable: the system's own
 * selection would answer the same hold. Select opens them where they can be.
 */
export function MessageHold(
  props: MessageActionOptions & {
    readonly children: ReactNode;
    readonly previewRadius: number;
    readonly style?: StyleProp<ViewStyle>;
    /** What this bubble holds: what Copy, Select and Share take. */
    readonly text: string;
  },
): ReactNode {
  const { code, onActivity, onReply, text, whole } = props;
  const [selecting, setSelecting] = useState(false);
  const worded = text !== "";
  const actions = useMemo(
    () => messageActions({ code, onActivity, onReply, whole, worded }),
    [code, onActivity, onReply, whole, worded],
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
    [onActivity, onReply, text, whole],
  );
  return (
    <>
      <HoldMenu
        actions={actions}
        onAction={act}
        previewRadius={props.previewRadius}
        style={props.style}
      >
        {props.children}
      </HoldMenu>
      {selecting ? (
        <Sheet onClose={() => setSelecting(false)} open title="Select text">
          <Text selectable style={{ ...type.reading, color: color.text }}>
            {text}
          </Text>
        </Sheet>
      ) : null}
    </>
  );
}
