import type { ReactNode } from "react";
import { SettingsHost, SettingsList } from "./settings-form-primitives.android.js";
export function SettingsPageLayout({ children }: { readonly children: ReactNode }) {
  return (
    <SettingsHost>
      <SettingsList>{children}</SettingsList>
    </SettingsHost>
  );
}
