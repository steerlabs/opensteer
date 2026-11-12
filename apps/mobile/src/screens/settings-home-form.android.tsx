import { contactSupport } from "../report-mail.js";
import { settingsDestinations, type SettingsHomeTeam } from "./settings-home-model.js";
import {
  LinkRow,
  Section,
  SettingsHost,
  SettingsList,
} from "./settings-form-primitives.android.js";
export function SettingsHomeForm({
  onOpen,
  team,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
  readonly team: SettingsHomeTeam | null;
}) {
  return (
    <SettingsHost>
      <SettingsList>
        {["", "For your agents"].map((group) => (
          <Section key={group} title={group}>
            {settingsDestinations
              .filter((item) => item.group === group)
              .map((item) => (
                <LinkRow key={item.route} onPress={() => onOpen(item.route)} title={item.title} />
              ))}
          </Section>
        ))}
        {team ? (
          <Section title={team.name}>
            {team.rows.map((row) => (
              <LinkRow key={row.title} onPress={row.onPress} title={row.title} />
            ))}
          </Section>
        ) : null}
        <Section>
          <LinkRow onPress={() => contactSupport()} title="Contact support" />
        </Section>
      </SettingsList>
    </SettingsHost>
  );
}
