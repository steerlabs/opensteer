import type { ReactNode } from "react";
import type { SettingsFormProps } from "../src/screens/settings-form.types.js";

import { AiSettingsForm } from "../src/screens/settings-ai-form.js";
import { DevicesSettingsForm } from "../src/screens/settings-devices-form.js";
import { GeneralSettingsForm } from "../src/screens/settings-general-form.js";
import { SignInsSettingsForm } from "../src/screens/settings-sign-ins-form.js";
export function SettingsForm(props: SettingsFormProps): ReactNode {
  return (
    <>
      {props.page === undefined || props.page === "general" ? (
        <GeneralSettingsForm {...props} />
      ) : null}
      {props.page === undefined || props.page === "devices" ? (
        <DevicesSettingsForm {...props} />
      ) : null}
      {props.page === undefined || props.page === "ai" ? <AiSettingsForm {...props} /> : null}
      {props.page === undefined || props.page === "sign-ins" ? (
        <SignInsSettingsForm {...props} />
      ) : null}
    </>
  );
}
