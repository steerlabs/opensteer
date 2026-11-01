import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { radius, deploymentPaint } from "../theme.js";
import type { DeploymentMark } from "./deployment-identity.js";

/**
 * A Deployment's identity: an initial on a tinted rounded square, with its own
 * stable palette independent of tasks and specialists.
 *
 * The mark is decoration in the accessibility tree: the control or row it sits
 * in already says the Deployment's name, and a screen reader that read the mark
 * as well would say it twice. Its initial never scales with Dynamic Type; it is
 * a graphic sized to the square, and the name beside it grows instead.
 */
export function DeploymentMarkView(props: { readonly mark: DeploymentMark }): ReactNode {
  const palette = deploymentPaint[props.mark.tone];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, { backgroundColor: palette.fill }]}
    >
      <Text allowFontScaling={false} style={[styles.initial, { color: palette.ink }]}>
        {props.mark.initial}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  initial: { fontSize: 13, fontWeight: "700", letterSpacing: -0.2 },
  mark: {
    alignItems: "center",
    borderRadius: radius.sm,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
});
