import type { ReactNode } from "react";
import { View } from "react-native";
import { ProviderMark } from "../thread/settings/engine-mark.js";
import { color, radius } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * An agent on the same quiet tile Settings rows use: its provider's mark, its initial
 * when it has one and no provider, and a plus for "Another agent".
 */
export function ExternalAgentMark(props: {
  readonly providerId: string | null;
  readonly initial?: string;
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
      {props.providerId === null && props.initial !== undefined ? (
        <AppText role="secondaryMedium" style={{ fontSize: Math.round(size * 0.47) }}>
          {props.initial}
        </AppText>
      ) : props.providerId === null ? (
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
