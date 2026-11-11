import { contactSupport } from "../report-mail.js";
import { FlatList, Pressable, View } from "react-native";
import { AppText } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import {
  settingsDestinations,
  settingsGroupTitle,
  settingsHomeDestinations,
  teamPlaceElsewhere,
  type SettingsHomeTeam,
} from "./settings-home-model.js";
export function SettingsHomeForm({
  onOpen,
  team,
  teamPlace,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
  readonly team: SettingsHomeTeam | null;
  readonly teamPlace: boolean;
}) {
  const destinations = settingsHomeDestinations(teamPlace);
  return (
    <Screen>
      <FlatList
        data={destinations}
        ListFooterComponent={
          <>
            {team ? (
              <View>
                <AppText>{team.name}</AppText>
                {team.rows.map((row) => (
                  <Pressable
                    accessibilityRole="button"
                    key={row.title}
                    onPress={row.onPress}
                    style={{ minHeight: 48, padding: 16 }}
                  >
                    <AppText>{row.title}</AppText>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {teamPlace ? (
              <View style={{ padding: 16 }}>
                <AppText role="caption" tone="muted">
                  {teamPlaceElsewhere}
                </AppText>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => contactSupport()}
              style={{ minHeight: 48, padding: 16 }}
            >
              <AppText>Contact support</AppText>
            </Pressable>
          </>
        }
        keyExtractor={(item) => item.route}
        renderItem={({ item, index }) => (
          <View>
            {item.group !== destinations[index - 1]?.group && item.group !== "" ? (
              <AppText>{settingsGroupTitle(item.group, teamPlace)}</AppText>
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
