import { useNavigation } from "@react-navigation/native";
import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { passwordsSettingsModel } from "./settings-model.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { SignInsSettingsForm } from "./settings-sign-ins-form.js";
import { useSettingsHost } from "./use-settings-host.js";
export function SignInsSettingsController(): ReactNode {
  const page = "sign-ins";
  const navigation = useNavigation();
  const { rows, selection } = useMobileState();
  const [passwordsShown, setPasswordsShown] = useState(false);
  const snapshot = useSettingsHost(selection.hostClient);
  const selectedRow = rows.find((row) => row.deploymentId === selection.deploymentId) ?? null;
  const passwords = useMemo(
    () =>
      snapshot === null
        ? null
        : passwordsSettingsModel({
            deploymentKind: snapshot.deploymentShape?.kind ?? null,
            deploymentName:
              selectedRow?.name ?? snapshot.identityConfig?.deployment.name ?? "your Mac",
            machines: snapshot.machines,
          }),
    [selectedRow?.name, snapshot],
  );
  const { deploymentId } = selection;
  const signIns = useMemo(
    () =>
      deploymentId === null || selection.hostClient === null
        ? null
        : {
            onBrowserProfiles: () => navigation.navigate("BrowserProfiles", { deploymentId }),
            onChrome: () => navigation.navigate("Chrome", { deploymentId }),
            onConnectedApps: () => navigation.navigate("ConnectedApps", { deploymentId }),
            onPlugins: () => navigation.navigate("Plugins", { deploymentId }),
          },
    [deploymentId, navigation, selection.hostClient],
  );
  return (
    <>
      <SettingsPageLayout>
        <SignInsSettingsForm
          page={page}
          onPasswordsAction={() => setPasswordsShown(true)}
          passwords={passwords}
          signIns={signIns}
        />
      </SettingsPageLayout>
      {passwords === null ? null : (
        <Sheet
          onClose={() => setPasswordsShown(false)}
          open={passwordsShown}
          title={passwords.title}
        >
          <View style={styles.passwords}>
            <AppText role="body">{passwords.body}</AppText>
            {passwords.facts.map((fact) => (
              <AppText key={fact} role="secondary" tone="soft">
                {fact}
              </AppText>
            ))}
          </View>
        </Sheet>
      )}
    </>
  );
}

const styles = StyleSheet.create({ passwords: { gap: 12, padding: 16 } });
