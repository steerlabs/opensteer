import { Section } from "@expo/ui/swift-ui";
import type { ReactNode } from "react";
import { LinkRow } from "./settings-form-primitives.ios.js";
import type { SettingsFormProps } from "./settings-form.types.js";
import {
  agentAccessSectionTitle,
  browserProfilesSettingsRow,
  chromeSettingsRow,
  connectedAppsSettingsRow,
  pluginsSettingsRow,
} from "./settings-model.js";
export function SignInsSettingsForm(
  props: Pick<SettingsFormProps, "page" | "signIns" | "passwords" | "onPasswordsAction">,
): ReactNode {
  return (
    <>
      {props.signIns === null ? null : (
        <Section title={agentAccessSectionTitle}>
          {props.page === undefined ? (
            <>
              <LinkRow
                detail={connectedAppsSettingsRow.detail}
                onPress={props.signIns.onConnectedApps}
                symbol="powerplug"
                title={connectedAppsSettingsRow.title}
              />
              <LinkRow
                detail={pluginsSettingsRow.detail}
                onPress={props.signIns.onPlugins}
                symbol="puzzlepiece.extension"
                title={pluginsSettingsRow.title}
              />
            </>
          ) : null}
          <LinkRow
            detail={chromeSettingsRow.detail}
            onPress={props.signIns.onChrome}
            symbol="globe"
            title={chromeSettingsRow.title}
          />
          <LinkRow
            detail={browserProfilesSettingsRow.detail}
            onPress={props.signIns.onBrowserProfiles}
            symbol="rectangle.on.rectangle"
            title={browserProfilesSettingsRow.title}
          />
          {props.passwords === null ? null : (
            <LinkRow
              detail={props.passwords.detail}
              onPress={props.onPasswordsAction}
              symbol="key"
              title={props.passwords.title}
            />
          )}
        </Section>
      )}
    </>
  );
}
