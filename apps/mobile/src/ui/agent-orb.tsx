import type { ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { material } from "../theme.js";

/** The Opensteer orb at any size: an agent's mark wherever one appears. */
export function AgentOrb(props: { readonly size: number }): ReactNode {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: props.size, width: props.size }}
    >
      <Image
        resizeMode="contain"
        source={require("../../assets/opensteer.png") as number}
        style={{ height: props.size, width: props.size }}
      />
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, material.mark, { borderRadius: props.size / 2 }]}
      />
    </View>
  );
}
