import { contactSupport } from "../report-mail.js";
import { Button, Form, Host, Section, Text } from "@expo/ui/swift-ui";
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
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <Form>
        {["", "For your agents"].map((group) => (
          <Section key={group} title={settingsGroupTitle(group, teamPlace)}>
            {destinations
              .filter((item) => item.group === group)
              .map((item) => (
                <Button key={item.route} label={item.title} onPress={() => onOpen(item.route)} />
              ))}
          </Section>
        ))}
        {team ? (
          <Section title={team.name}>
            {team.rows.map((row) => (
              <Button key={row.title} label={row.title} onPress={row.onPress} />
            ))}
          </Section>
        ) : null}
        <Section footer={teamPlace ? <Text>{teamPlaceElsewhere}</Text> : undefined}>
          <Button label="Contact support" onPress={() => contactSupport()} />
        </Section>
      </Form>
    </Host>
  );
}
