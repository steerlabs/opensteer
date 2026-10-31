import { usageLimitNoticeText, type UsageLimitNotice } from "@opensteer/client/host";
import { useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * The quiet line under a composer whose AI has run out of plan capacity (see
 * `usageLimitNotice`). It sits outside the bar, so nothing tints the field,
 * and dismissing it changes nothing but whether it is shown on this phone.
 */
export function UsageNotice(props: {
  readonly notice: UsageLimitNotice | null;
  /** Where the AI is changed: the line itself opens it. */
  readonly onOpen: () => void;
}): ReactNode {
  return props.notice === null ? null : (
    <UsageNoticeLine notice={props.notice} onOpen={props.onOpen} />
  );
}

function UsageNoticeLine(props: {
  readonly notice: UsageLimitNotice;
  readonly onOpen: () => void;
}): ReactNode {
  const dismissals = useMobileClient().usageNotices;
  const dismissed = useSyncExternalStore(
    dismissals.subscribe,
    dismissals.getSnapshot,
    dismissals.getSnapshot,
  );
  if (dismissed === null || dismissed.has(props.notice.key)) return null;
  const text = usageLimitNoticeText(props.notice);
  return (
    <View accessibilityLiveRegion="polite" style={styles.line}>
      <Pressable
        accessibilityHint="Opens AI settings"
        accessibilityLabel={`${text}, ${props.notice.accountTitle}`}
        accessibilityRole="button"
        onPress={props.onOpen}
        style={styles.words}
      >
        <AppText numberOfLines={2} role="caption" tone="muted">
          {text}
        </AppText>
      </Pressable>
      <Pressable
        accessibilityLabel="Dismiss usage notice"
        accessibilityRole="button"
        onPress={() => dismissals.dismiss(props.notice.key)}
        style={styles.dismiss}
      >
        <Symbol name="xmark" size={12} tint={color.mutedDim} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  dismiss: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  // The dock's row gap is for other controls; this caption sits directly below its bar.
  line: {
    alignItems: "center",
    flexDirection: "row",
    marginTop: -space[8],
    paddingLeft: space[12],
  },
  words: { flex: 1, justifyContent: "center", minHeight: touchTarget },
});
