import type { ReactNode } from "react";
import { LinkRow, Section } from "./settings-form-primitives.android.js";
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
  const signIns = props.signIns;
  if (signIns === null) return null;
  return (
    <Section title={agentAccessSectionTitle}>
      {props.page === undefined ? (
        <>
          <LinkRow
            detail={connectedAppsSettingsRow.detail}
            onPress={signIns.onConnectedApps}
            title={connectedAppsSettingsRow.title}
          />
          <LinkRow
            detail={pluginsSettingsRow.detail}
            onPress={signIns.onPlugins}
            title={pluginsSettingsRow.title}
          />
        </>
      ) : null}
      <LinkRow
        detail={chromeSettingsRow.detail}
        onPress={signIns.onChrome}
        title={chromeSettingsRow.title}
      />
      <LinkRow
        detail={browserProfilesSettingsRow.detail}
        onPress={signIns.onBrowserProfiles}
        title={browserProfilesSettingsRow.title}
      />
      {props.passwords === null ? null : (
        <LinkRow
          detail={props.passwords.detail}
          onPress={props.onPasswordsAction}
          title={props.passwords.title}
        />
      )}
    </Section>
  );
}
