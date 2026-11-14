import { TranscriptImageContext } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { use, type ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";

/**
 * "Edited", on a message a person changed while it waited. It opens every
 * version, so what the agent was asked is never in doubt.
 */
export function EditedMark(props: { readonly messageId: string }): ReactNode {
  const navigation = useNavigation();
  const mobile = useMobileClient();
  const threadId = use(TranscriptImageContext)?.threadId ?? null;
  const label = (
    <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
      Edited
    </AppText>
  );
  if (threadId === null) return label;
  return (
    <Pressable
      accessibilityHint="Shows every version of this message"
      accessibilityLabel="Edited"
      accessibilityRole="button"
      hitSlop={{ bottom: space[12], left: space[8], right: space[8], top: space[12] }}
      onPress={() => {
        // Read as it is pressed: the mark never redraws for the selection.
        const deploymentId = mobile.getSnapshot().selection.deploymentId;
        if (deploymentId === null) return;
        navigation.navigate("MessageHistory", {
          deploymentId,
          messageId: props.messageId,
          threadId,
        });
      }}
      style={({ pressed }) => [styles.mark, pressed && styles.pressed]}
    >
      {label}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The caption's own height in its row; the touch reaches past it.
  mark: { justifyContent: "center", minHeight: touchTarget - space[24] },
  pressed: { opacity: 0.6 },
});
