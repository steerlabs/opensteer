import type { SavedChat as SavedChatContent } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { PlainProse } from "../markdown/markdown.js";
import { color, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { useReadingColumn } from "../ui/screen.js";

/** Text has no Host/client prop, links, media, activation or read effects. */
export function SavedChat(props: {
  readonly content: SavedChatContent;
  readonly capturedAt: string;
  readonly paddingTop: number;
}): ReactNode {
  const column = useReadingColumn();
  return (
    <ScrollView
      accessibilityLabel={`Saved view, last updated ${props.capturedAt}.`}
      contentContainerStyle={[column, styles.content, { paddingTop: props.paddingTop + space[16] }]}
    >
      <AppText role="caption" tone="muted">
        Recent saved messages
      </AppText>
      {props.content.messages.map((message, index) => (
        <View key={index} style={message.voice === "mine" ? styles.mine : styles.message}>
          {message.voice === "input" ? (
            <AppText role="caption" tone="muted">
              Last seen input
            </AppText>
          ) : null}
          <PlainProse text={message.text} tone={message.voice === "mine" ? "bubble" : "default"} />
        </View>
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  content: { gap: space[16], paddingBottom: space[24] },
  message: { gap: space[6] },
  mine: {
    alignSelf: "flex-end",
    maxWidth: "100%",
    backgroundColor: color.bubble,
    borderRadius: radius.xl,
    borderBottomEndRadius: radius.xs,
    padding: space[12],
  },
});
