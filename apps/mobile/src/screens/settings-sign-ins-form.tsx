import type { ReactNode } from "react";
import { RowGroup } from "../ui/primitives.js";
import { LinkRow, Section, Tile } from "./settings-form-primitives.js";
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
        <Section label={agentAccessSectionTitle}>
          <RowGroup>
            {[
              props.page === undefined ? (
                <>
                  <LinkRow
                    detail={connectedAppsSettingsRow.detail}
                    key="connected-apps"
                    lead={<Tile symbol="powerplug" />}
                    onPress={props.signIns.onConnectedApps}
                    title={connectedAppsSettingsRow.title}
                  />
                  <LinkRow
                    detail={pluginsSettingsRow.detail}
                    key="plugins"
                    lead={<Tile symbol="puzzlepiece.extension" />}
                    onPress={props.signIns.onPlugins}
                    title={pluginsSettingsRow.title}
                  />
                </>
              ) : null,
              <LinkRow
                detail={chromeSettingsRow.detail}
                key="chrome"
                lead={<Tile symbol="globe" />}
                onPress={props.signIns.onChrome}
                title={chromeSettingsRow.title}
              />,
              <LinkRow
                detail={browserProfilesSettingsRow.detail}
                key="browser-profiles"
                lead={<Tile symbol="rectangle.on.rectangle" />}
                onPress={props.signIns.onBrowserProfiles}
                title={browserProfilesSettingsRow.title}
              />,
              props.passwords === null ? null : (
                <LinkRow
                  detail={props.passwords.detail}
                  key="passwords"
                  lead={<Tile symbol="key" />}
                  onPress={props.onPasswordsAction}
                  title={props.passwords.title}
                />
              ),
            ]}
          </RowGroup>
        </Section>
      )}
    </>
  );
}
