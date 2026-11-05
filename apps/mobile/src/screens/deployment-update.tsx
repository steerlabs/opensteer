import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { styles } from "./settings-form-primitives.js";
import type { DeploymentUpdateModel } from "./use-deployment-update.js";

export function deploymentUpdateRows(update: DeploymentUpdateModel): readonly ReactNode[] {
  const { view } = update;
  return [
    <View accessibilityLiveRegion="polite" key="status" style={styles.row}>
      <AppText role="body">{view.headline}</AppText>
      {view.statusLine === null ? null : (
        <AppText role="secondary" tone="muted">
          {view.statusLine}
        </AppText>
      )}
    </View>,
    view.versionLine === null ? null : (
      <View key="version" style={styles.rowInline}>
        <AppText role="body">{view.versionLine}</AppText>
        <AppText role="body" tone="muted">
          {view.channel}
        </AppText>
      </View>
    ),
    view.result === null ? null : (
      <View accessibilityLiveRegion="polite" key="result" style={styles.row}>
        <AppText
          role="secondary"
          tone={
            view.result.tone === "attention"
              ? "danger"
              : view.result.tone === "success"
                ? "default"
                : "soft"
          }
        >
          {view.result.text}
        </AppText>
      </View>
    ),
    ...[view.action, view.channelAction].map((action) =>
      action === null ? null : (
        <View key={action.label} style={styles.actionRow}>
          <SecondaryButton label={action.label} onPress={() => update.onAction(action)} />
        </View>
      ),
    ),
  ];
}
