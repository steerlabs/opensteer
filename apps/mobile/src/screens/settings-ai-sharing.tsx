import { useSyncExternalStore } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useAiSharing } from "../ui/ai-sharing.js";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { space } from "../theme.js";

export function SettingsAiSharingScreen() {
  const sharing = useAiSharing();
  const records = useSyncExternalStore(sharing.subscribe, sharing.getSnapshot, sharing.getSnapshot);
  const companies = [...new Set(records.map((record) => record.company))];
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space[20], gap: space[20] }}>
        <AppText>
          These permissions are saved on this device. Stopping sharing asks again before your next
          send or call. It does not stop running work or recall data already sent.
        </AppText>
        {companies.length === 0 ? (
          <AppText>No AI sharing allowed yet.</AppText>
        ) : (
          companies.map((company) => (
            <View key={company} style={{ gap: space[8] }}>
              <AppText role="bodyMedium">{`${company[0]?.toUpperCase()}${company.slice(1)}`}</AppText>
              <AppText>
                {records
                  .filter((record) => record.company === company)
                  .map((record) => (record.scope === "audio" ? "Live audio" : "Messages and files"))
                  .join(" · ")}
              </AppText>
              <SecondaryButton
                label="Stop sharing"
                onPress={() => {
                  try {
                    sharing.stop(company);
                  } catch {
                    Alert.alert("Could not save your choice", "Please try again.");
                  }
                }}
              />
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
