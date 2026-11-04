import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { Screen, useListContentInsets, useReadingColumn } from "../src/ui/screen.js";
import type { SettingsFormProps } from "../src/screens/settings-form.types.js";

import { AccountSettingsForm } from "../src/screens/settings-account-form.js";
import { AiSettingsForm } from "../src/screens/settings-ai-form.js";
import { DevicesSettingsForm } from "../src/screens/settings-devices-form.js";
import { GeneralSettingsForm } from "../src/screens/settings-general-form.js";
import { SignInsSettingsForm } from "../src/screens/settings-sign-ins-form.js";
export function SettingsForm(props: SettingsFormProps): ReactNode {
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[
          { gap: 24, padding: 16 },
          useReadingColumn(),
          useListContentInsets(32),
        ]}
      >
        {props.page === undefined || props.page === "general" ? (
          <GeneralSettingsForm {...props} />
        ) : null}
        {props.page === undefined || props.page === "account" ? (
          <AccountSettingsForm {...props} />
        ) : null}
        {props.page === undefined || props.page === "devices" ? (
          <DevicesSettingsForm {...props} />
        ) : null}
        {props.page === undefined || props.page === "ai" ? <AiSettingsForm {...props} /> : null}
        {props.page === undefined || props.page === "sign-ins" ? (
          <SignInsSettingsForm {...props} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
