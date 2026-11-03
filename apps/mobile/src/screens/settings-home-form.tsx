import { FlatList, Pressable, View } from "react-native";
import { Screen } from "../ui/screen.js";
import { AppText } from "../ui/primitives.js";
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
        keyExtractor={(item) => item.route}
        renderItem={({ item, index }) => (
          <View>
            {index === 4 ? <AppText>For your agents</AppText> : null}
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
