import type { ReactNode } from "react";
import { Image, View } from "react-native";

/** Chat keeps the product's orb; its tasks have their own subject marks. */
export function ChatOrb(props: { readonly size: 16 | 20 | 22 }): ReactNode {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Image
        source={require("../../assets/opensteer.png") as number}
        resizeMode="contain"
        style={{ width: props.size, height: props.size }}
      />
    </View>
  );
}
