import { integrationMark, type BundledIntegrationIconId } from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { color, radius } from "../theme.js";

/**
 * The finished tiles this build ships, by the shared list's id.
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
 * One integration's mark, at the size a row or a sheet header wears: the same
 * tile and vector web draws, from the shared table.
 *
 * It is decoration in the accessibility tree — the name is already beside it as
 * text — so it is hidden rather than announced a second time, exactly as
 * `WorkspaceMark` is. An integration with no mark gets a neutral tile with its
 * initials, so every row keeps its leading mark.
 */
export function IntegrationIcon(props: {
  readonly definitionId: string;
  readonly name: string;
  readonly size?: number;
}): ReactNode {
  const mark = integrationMark(props.definitionId);
  const size = props.size ?? 32;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        { height: size, width: size },
        mark === null ? styles.initialsTile : mark.kind === "art" ? null : styles.markTile,
      ]}
    >
      {mark === null ? (
        // The initials are a graphic sized to the tile, not text to read, so
        // they never grow with Dynamic Type.
        <Text allowFontScaling={false} style={styles.initials}>
          {props.name.slice(0, 2).toLocaleUpperCase()}
        </Text>
      ) : mark.kind === "art" ? (
        // A shipped tile is finished: it fills the frame, unpadded.
        <Image resizeMode="cover" source={bundledSources[mark.art]} style={styles.art} />
      ) : (
        <Svg height={size * 0.58} viewBox="0 0 24 24" width={size * 0.58}>
          {mark.kind === "brand" ? (
            <Path d={mark.d} fill={mark.color} />
          ) : (
            <Path
              d={mark.d}
              fill="none"
              stroke={mark.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />
          )}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  art: { borderRadius: radius.sm, height: "100%", width: "100%" },
  initials: { color: color.textSoft, fontSize: 11, fontWeight: "700", letterSpacing: -0.4 },
  initialsTile: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderWidth: 1,
  },
  // A brand's colours are drawn for a light ground, as app icons are, in both themes.
  markTile: {
    backgroundColor: "#FFFFFF",
    borderColor: "rgba(0,0,0,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
  },
  tile: {
    alignItems: "center",
    borderRadius: radius.sm,
    justifyContent: "center",
    overflow: "hidden",
  },
});
