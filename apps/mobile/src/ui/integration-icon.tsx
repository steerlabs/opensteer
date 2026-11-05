import { integrationMark, type BundledIntegrationIconId } from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { color, radius } from "../theme.js";

/**
 * Local artwork keyed by the shared asset ids.
 *
 * The bytes are part of the app: nothing here asks a Host or a third party for
 * an image, which would tell somebody else which integrations a person uses.
 * Metro needs a literal path per entry, so the record is written out and typed
 * by the shared list — adding an id there without its artwork does not compile.
 */
const bundledSources: Readonly<Record<BundledIntegrationIconId, number>> = {
  "apple-messages": require("@opensteer/client/assets/integrations/apple-messages.png") as number,
  "apple-contacts": require("@opensteer/client/assets/integrations/apple-contacts.png") as number,
  "apple-photos": require("@opensteer/client/assets/integrations/apple-photos.png") as number,
  "apple-notes": require("@opensteer/client/assets/integrations/apple-notes.png") as number,
  "apple-reminders": require("@opensteer/client/assets/integrations/apple-reminders.png") as number,
  "apple-calendar": require("@opensteer/client/assets/integrations/apple-calendar.png") as number,
  "google-docs": require("@opensteer/client/assets/integrations/google-docs.png") as number,
  "google-drive": require("@opensteer/client/assets/integrations/google-drive.png") as number,
  "google-gmail": require("@opensteer/client/assets/integrations/google-gmail.png") as number,
  "google-calendar": require("@opensteer/client/assets/integrations/google-calendar.png") as number,
  "google-sheets": require("@opensteer/client/assets/integrations/google-sheets.png") as number,
  "google-slides": require("@opensteer/client/assets/integrations/google-slides.png") as number,
  "google-forms": require("@opensteer/client/assets/integrations/google-forms.png") as number,
  axiom: require("@opensteer/client/assets/integrations/axiom.png") as number,
  browserbase: require("@opensteer/client/assets/integrations/browserbase.png") as number,
  context7: require("@opensteer/client/assets/integrations/context7.png") as number,
  exa: require("@opensteer/client/assets/integrations/exa.png") as number,
  firecrawl: require("@opensteer/client/assets/integrations/firecrawl.png") as number,
  microsoft: require("@opensteer/client/assets/integrations/microsoft.png") as number,
  monday: require("@opensteer/client/assets/integrations/monday.png") as number,
  openai: require("@opensteer/client/assets/integrations/openai.png") as number,
  twilio: require("@opensteer/client/assets/integrations/twilio.png") as number,
  "val-town": require("@opensteer/client/assets/integrations/val-town.png") as number,
  figma: require("@opensteer/client/assets/integrations/figma.png") as number,
  slack: require("@opensteer/client/assets/integrations/slack.png") as number,
  "google-contacts": require("@opensteer/client/assets/integrations/google-contacts.png") as number,
  gitlab: require("@opensteer/client/assets/integrations/gitlab.png") as number,
  posthog: require("@opensteer/client/assets/integrations/posthog.png") as number,
  cloudflare: require("@opensteer/client/assets/integrations/cloudflare.png") as number,
  neon: require("@opensteer/client/assets/integrations/neon.png") as number,
  asana: require("@opensteer/client/assets/integrations/asana.png") as number,
  "microsoft-outlook":
    require("@opensteer/client/assets/integrations/microsoft-outlook.png") as number,
  "microsoft-teams": require("@opensteer/client/assets/integrations/microsoft-teams.png") as number,
  "microsoft-todo": require("@opensteer/client/assets/integrations/microsoft-todo.png") as number,
  "microsoft-onedrive":
    require("@opensteer/client/assets/integrations/microsoft-onedrive.png") as number,
  "microsoft-onenote":
    require("@opensteer/client/assets/integrations/microsoft-onenote.png") as number,
  deepwiki: require("@opensteer/client/assets/integrations/deepwiki.png") as number,
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
      ) : mark.kind === "art" || mark.kind === "logo" ? (
        <Image
          resizeMode="contain"
          source={bundledSources[mark.art]}
          style={mark.kind === "art" ? styles.art : styles.logo}
        />
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
  logo: { height: "58%", width: "58%" },
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
