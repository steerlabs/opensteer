import { contactSupport } from "../report-mail.js";
import { FlatList, Pressable, View } from "react-native";
import { AppText } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { settingsDestinations } from "./settings-home-model.js";
export function SettingsHomeForm({
  onOpen,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
}) {
  return (
    <Screen>
      <FlatList
        data={settingsDestinations}
        ListFooterComponent={
          <Pressable
            accessibilityRole="button"
            onPress={() => contactSupport()}
            style={{ minHeight: 48, padding: 16 }}
          >
            <AppText>Contact support</AppText>
          </Pressable>
        }
        keyExtractor={(item) => item.route}
        renderItem={({ item, index }) => (
          <View>
            {item.group !== settingsDestinations[index - 1]?.group && item.group !== "" ? (
              <AppText>For your agents</AppText>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              onPress={() => onOpen(item.route)}
              style={{ minHeight: 48, padding: 16 }}
            >
              <AppText>{item.title}</AppText>
            </Pressable>
          </View>
        )}
      />
    </Screen>
  );
}
