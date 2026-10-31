import type { ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { material } from "../theme.js";

/** Chat keeps the product's orb; its tasks have their own subject marks. */
export function ChatOrb(props: { readonly size: 16 | 20 | 22 }): ReactNode {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Image
        source={require("../../assets/opensteer.png") as number}
        resizeMode="contain"
        style={{ width: props.size, height: props.size }}
      />
      {/* The orb is a picture, which an inset light would sit beneath. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, material.mark, { borderRadius: props.size / 2 }]}
      />
    </View>
  );
}
