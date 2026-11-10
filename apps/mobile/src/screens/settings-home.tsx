import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMobileState } from "../ui/mobile-client-context.js";
import type { HostClient } from "@opensteer/client/host";
import { useTeam } from "@opensteer/client/react";
import { SettingsHomeForm } from "./settings-home-form.js";
import type { SettingsHomeTeam } from "./settings-home-model.js";
import { GeneralSettingsController } from "./settings-general-controller.js";
import { AccountSettingsController } from "./settings-account-controller.js";
import { DevicesSettingsController } from "./settings-devices-controller.js";
import { AiSettingsController } from "./settings-ai-controller.js";
import { SignInsSettingsController } from "./settings-sign-ins-controller.js";
import { ExternalAgentsSettingsController } from "./settings-external-agents-controller.js";
const pages = {
  general: GeneralSettingsController,
  account: AccountSettingsController,
  devices: DevicesSettingsController,
  ai: AiSettingsController,
  "sign-ins": SignInsSettingsController,
  "external-agents": ExternalAgentsSettingsController,
};
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import type { SettingsPage } from "./settings-form.types.js";
export function SettingsScreen() {
  const { selection } = useMobileState();
  const host = useAttachedHost(selection.deploymentId ?? "");
  return host && selection.deploymentId ? (
    <TeamSettingsHome deploymentId={selection.deploymentId} host={host} />
  ) : (
    <SettingsHome team={null} />
  );
}

/** Adds the team's own rows only when its Host offers them to this person. */
function TeamSettingsHome(props: { readonly deploymentId: string; readonly host: HostClient }) {
  const navigation = useNavigation();
  const { summary } = useTeam(props.host);
  const rows = [
    ...(summary?.can.people.allowed ? [{ title: "People", route: "TeamPeople" as const }] : []),
    ...(summary?.can.groups.allowed ? [{ title: "Groups", route: "TeamGroups" as const }] : []),
  ];
  return (
    <SettingsHome
      team={
        summary && rows.length
          ? {
              name: summary.team.name,
              rows: rows.map((row) => ({
                title: row.title,
                onPress: () => navigation.navigate(row.route, { deploymentId: props.deploymentId }),
              })),
            }
          : null
      }
    />
  );
}

function SettingsHome(props: { readonly team: SettingsHomeTeam | null }) {
  const navigation = useNavigation();
  const { selection } = useMobileState();
  return (
    <SettingsHomeForm
      team={props.team}
      onOpen={(route) => {
        if (route === "SettingsAiSharing") {
          navigation.navigate(route);
          return;
        }
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
export const SettingsExternalAgentsScreen = (props: Props) => (
  <Page {...props} page="external-agents" />
);

export function SettingsRemoteAccessScreen({ route }: Props) {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <AccountSettingsController key={route.params.deploymentId} detail="remote" />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
export function SettingsSessionDetailScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string; readonly sessionId: string }>) {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <AccountSettingsController
      key={route.params.deploymentId}
      detail="session"
      sessionId={route.params.sessionId}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
