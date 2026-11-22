import { contactSupport } from "../report-mail.js";
import { settingsDestinations, type SettingsHomeWork } from "./settings-home-model.js";
import {
  LinkRow,
  Section,
  SettingsHost,
  SettingsList,
} from "./settings-form-primitives.android.js";
export function SettingsHomeForm({
  onOpen,
  work = null,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
  /** Only on a work Home; a personal Home shows nothing more. */
  readonly work?: SettingsHomeWork | null;
}) {
  return (
    <SettingsHost>
      <SettingsList>
        {work ? (
          <Section title={work.badge}>
            <LinkRow onPress={work.onPress} title={work.title} />
          </Section>
        ) : null}
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
