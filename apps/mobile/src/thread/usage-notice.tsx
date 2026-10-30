import {
  executionUsageNotice,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { color, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
export function UsageNotice({
  placements,
  selection,
  onSwitch,
}: {
  placements: readonly ThreadPlacementOption[];
  selection: ExecutionSelection | null;
  onSwitch: () => void;
}): ReactNode {
  const notice = executionUsageNotice(placements, selection);
  if (!notice) return null;
  return (
    <View
      style={{
        backgroundColor: color.amberWash,
        flexDirection: "row",
        alignItems: "center",
        gap: space[8],
        paddingHorizontal: space[12],
        paddingVertical: space[6],
      }}
    >
      <AppText role="caption" style={{ color: color.amber, flex: 1 }}>
        {notice.accountTitle} is out of {notice.engineName} usage
        {notice.resetsAt ? ` until ${notice.resetsAt}` : ""}.
      </AppText>
      {notice.canSwitch ? (
        <Pressable
          accessibilityRole="button"
          onPress={onSwitch}
          style={{ minHeight: touchTarget, justifyContent: "center" }}
        >
          <AppText role="caption" style={{ color: color.amber }}>
            Switch account
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
