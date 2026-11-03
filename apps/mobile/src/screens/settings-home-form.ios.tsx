import { Button, Form, Host, Section } from "@expo/ui/swift-ui";
import { settingsDestinations } from "./settings-home-model.js";
export function SettingsHomeForm({
  onOpen,
}: {
  readonly onOpen: (route: (typeof settingsDestinations)[number]["route"]) => void;
}) {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <Form>
        {["", "For your agents"].map((group) => (
          <Section key={group} title={group}>
            {settingsDestinations
              .filter((item) => item.group === group)
              .map((item) => (
                <Button key={item.route} label={item.title} onPress={() => onOpen(item.route)} />
              ))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}
