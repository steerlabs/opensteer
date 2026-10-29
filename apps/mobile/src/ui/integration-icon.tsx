import {
  bundledIntegrationIcon,
  type BundledIntegrationIconId,
} from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { color, radius } from "../theme.js";

/**
 * The marks this build ships, by definition id.
 *
 * The bytes are part of the app: nothing here asks a Host or a third party for
 * an image, which would tell somebody else which integrations a person uses.
 * Metro needs a literal path per entry, so the record is written out and typed
 * by the shared list — adding an id there without its artwork does not compile.
 */
const bundledSources: Readonly<Record<BundledIntegrationIconId, number>> = {
  "apple-messages": require("@opensteer/client/assets/integrations/apple-messages.png") as number,
};

/**
 * One integration's mark, at the size a row or a sheet header wears.
 *
 * It is decoration in the accessibility tree — the name is already beside it as
 * text — so it is hidden rather than announced a second time, exactly as
 * `WorkspaceMark` is. An integration this build ships no artwork for gets the
 * same neutral tile with its initials, so every row keeps its leading mark.
 */
export function IntegrationIcon(props: {
  readonly definitionId: string;
  readonly name: string;
}): ReactNode {
  const bundled = bundledIntegrationIcon(props.definitionId);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, bundled === null ? styles.fallback : null]}
    >
      {bundled === null ? (
        // The initials are a graphic sized to the tile, not text to read, so
        // they never grow with Dynamic Type.
        <Text allowFontScaling={false} style={styles.initials}>
          {props.name.slice(0, 2).toLocaleUpperCase()}
        </Text>
      ) : (
        // A shipped mark is a finished tile: it fills the frame, unpadded.
        <Image resizeMode="cover" source={bundledSources[bundled]} style={styles.art} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  art: { borderRadius: radius.sm, height: "100%", width: "100%" },
  fallback: { backgroundColor: color.surfaceRaised, borderColor: color.line, borderWidth: 1 },
  initials: { color: color.textSoft, fontSize: 11, fontWeight: "700", letterSpacing: -0.4 },
  mark: {
    alignItems: "center",
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    overflow: "hidden",
    width: 32,
  },
});
