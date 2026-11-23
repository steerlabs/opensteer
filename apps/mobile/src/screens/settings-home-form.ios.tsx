import { contactSupport } from "../report-mail.js";
import { Form, Host, Section } from "@expo/ui/swift-ui";
import { listStyle } from "@expo/ui/swift-ui/modifiers";
import { NavRow } from "./settings-form-primitives.ios.js";
import { settingsDestinations } from "./settings-home-model.js";
export function SettingsHomeForm({
  onOpen,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
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
        <Section>
          <NavRow onPress={() => contactSupport()} title="Contact support" />
        </Section>
      </Form>
    </Host>
  );
}
