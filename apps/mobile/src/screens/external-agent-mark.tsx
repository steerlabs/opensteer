import type { ReactNode } from "react";
import { View } from "react-native";
import { ProviderMark } from "../thread/settings/engine-mark.js";
import { color, radius } from "../theme.js";
import { Symbol } from "../ui/symbol.js";

/** An agent to add, on the same quiet tile Settings rows use; "Another agent" is a plus. */
export function ExternalAgentMark(props: {
  readonly providerId: string | null;
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 30;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignItems: "center",
        backgroundColor: color.surfaceRaised,
        borderRadius: size > 30 ? radius.md : radius.xs,
        height: size,
        justifyContent: "center",
        width: size,
      }}
    >
      {props.providerId === null ? (
        <Symbol name="plus" size={Math.round(size * 0.5)} tint={color.textSoft} />
      ) : (
        <ProviderMark
          providerId={props.providerId}
          size={Math.round(size * 0.53)}
          tint={color.text}
        />
      )}
    </View>
  );
}
