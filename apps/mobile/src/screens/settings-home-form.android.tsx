import { contactSupport } from "../report-mail.js";
import { settingsDestinations } from "./settings-home-model.js";
import {
  LinkRow,
  Section,
  SettingsHost,
  SettingsList,
} from "./settings-form-primitives.android.js";
export function SettingsHomeForm({
  onOpen,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
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
        <Section>
          <LinkRow onPress={() => contactSupport()} title="Contact support" />
        </Section>
      </SettingsList>
    </SettingsHost>
  );
}
