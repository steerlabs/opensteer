import { contactSupport } from "../report-mail.js";
import { Form, Host, Section } from "@expo/ui/swift-ui";
import { listStyle } from "@expo/ui/swift-ui/modifiers";
import { NavRow } from "./settings-form-primitives.ios.js";
import { settingsDestinations, type SettingsHomeTeam } from "./settings-home-model.js";
export function SettingsHomeForm({
  onOpen,
  team,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
  readonly team: SettingsHomeTeam | null;
}) {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <Form modifiers={[listStyle("insetGrouped")]}>
        {["", "For your agents"].map((group) => (
          <Section key={group} title={group}>
            {settingsDestinations
              .filter((item) => item.group === group)
              .map((item) => (
                <NavRow key={item.route} onPress={() => onOpen(item.route)} title={item.title} />
              ))}
          </Section>
        ))}
        {team ? (
          <Section title={team.name}>
            {team.rows.map((row) => (
              <NavRow key={row.title} onPress={row.onPress} title={row.title} />
            ))}
          </Section>
        ) : null}
        <Section>
          <NavRow onPress={() => contactSupport()} title="Contact support" />
        </Section>
      </Form>
    </Host>
  );
}
