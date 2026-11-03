import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMobileState } from "../ui/mobile-client-context.js";
import { SettingsHomeForm } from "./settings-home-form.js";
import { GeneralSettingsController } from "./settings-general-controller.js";
import { AccountSettingsController } from "./settings-account-controller.js";
import { DevicesSettingsController } from "./settings-devices-controller.js";
import { AiSettingsController } from "./settings-ai-controller.js";
import { SignInsSettingsController } from "./settings-sign-ins-controller.js";
const pages = {
  general: GeneralSettingsController,
  account: AccountSettingsController,
  devices: DevicesSettingsController,
  ai: AiSettingsController,
  "sign-ins": SignInsSettingsController,
};
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import type { SettingsPage } from "./settings-form.types.js";
export function SettingsScreen() {
  const navigation = useNavigation();
  const { selection } = useMobileState();
  return (
    <SettingsHomeForm
      onOpen={(route) => {
        if (selection.deploymentId)
          navigation.navigate(route, { deploymentId: selection.deploymentId });
        else navigation.navigate("DeploymentSwitcher");
      }}
    />
  );
}
type Props = StaticScreenProps<{ readonly deploymentId: string }>;
function Page({ route, page }: Props & { readonly page: SettingsPage }) {
  const host = useAttachedHost(route.params.deploymentId);
  const Controller = pages[page];
  return host ? (
    <Controller key={route.params.deploymentId} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
export const SettingsGeneralScreen = (props: Props) => <Page {...props} page="general" />;
export const SettingsAccountScreen = (props: Props) => <Page {...props} page="account" />;
export const SettingsDevicesScreen = (props: Props) => <Page {...props} page="devices" />;
export const SettingsAIScreen = (props: Props) => <Page {...props} page="ai" />;
export const SettingsSignInsScreen = (props: Props) => <Page {...props} page="sign-ins" />;
