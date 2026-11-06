import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import { Alert, Linking, Platform } from "react-native";
import { reportEmail, supportEmail } from "./report.js";

export function contactSupport(report?: {
  readonly kind: "reply" | "app";
  readonly id: string;
}): void {
  const draft = report
    ? reportEmail({
        ...report,
        version: Application.nativeApplicationVersion ?? "unknown",
        platform: Platform.OS,
      })
    : { subject: "Opensteer support", body: "" };
  void Linking.openURL(
    `mailto:${supportEmail}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`,
  ).catch(() => {
    Alert.alert("Contact support", supportEmail, [
      {
        text: "Copy address",
        onPress: () => {
          void Clipboard.setStringAsync(supportEmail);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  });
}
