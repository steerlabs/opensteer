import { useIdleCompactionSettings } from "@opensteer/client/react";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import { harnessDriverLabel } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState, type ReactNode } from "react";
import { notDone, useScreenAction } from "../ui/client-feedback.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AiSettingsForm } from "./settings-ai-form.js";
import { useAiAccounts } from "./settings-ai-accounts.js";
import { useBackgroundModels } from "./settings-background-models.js";
import type { AiAccountsForm, BackgroundModelsForm } from "./settings-form.types.js";
import { engineInstallationUpdateModel } from "./settings-model.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useShowTab } from "../tabs/viewer-open.js";
import { useSettingsHost } from "./use-settings-host.js";
export function AiSettingsController(): ReactNode {
  const page = "ai";
  const navigation = useNavigation();
  const { selection } = useMobileState();
  const [engineUpdateKey, setEngineUpdateKey] = useState<string | null>(null);
  const snapshot = useSettingsHost(selection.hostClient);
  const hostClient = selection.hostClient;
  const engineUpdate = useScreenAction(hostClient, "harness-update", {
    label: "update the engine",
    done: "updated",
    happened: "the engine was updated",
    execute: async (input: { environmentId: string; driverKind: string }) => {
      await hostClient!.dispatch({
        driverKind: input.driverKind,
        environmentId: input.environmentId,
        idempotencyKey: mutationIdempotencyKey(
          `harness-update:${input.environmentId}:${input.driverKind}`,
        ),
        type: "harness.update",
      });
    },
    // The snapshot says whether the computer took the update: it is under way or done.
    reconcile: async (input) => {
      const installation = hostClient
        ?.getSnapshot()
        .environments.find((environment) => environment.id === input.environmentId)
        ?.harnessDrivers.find((driver) => driver.driverKind === input.driverKind)?.installation;
      if (installation === undefined || installation === null) return null;
      return installation.update === "available"
        ? notDone("updated")
        : { kind: "confirmed", value: undefined };
    },
  });
  const engineUpdates = useMemo(() => {
    if (snapshot === null) return [];
    return snapshot.engineInstallations.map(({ driverKind, environmentId, installation }) => {
      const key = `${environmentId}:${driverKind}`;
      const model = engineInstallationUpdateModel(
        installation,
        key === engineUpdateKey && engineUpdate.running,
      );
      return {
        detail:
          key === engineUpdateKey && engineUpdate.line !== null
            ? engineUpdate.line.text
            : model.detail,
        driverKind,
        environmentId,
        key,
        name: harnessDriverLabel(driverKind),
        updateEnabled: snapshot.harnessUpdateAvailable && model.updateEnabled,
        updating: model.updating,
      };
    });
  }, [engineUpdate.line, engineUpdate.running, engineUpdateKey, snapshot]);
  const idleCompaction = useIdleCompactionSettings(hostClient);
  const form = (
    backgroundModels: BackgroundModelsForm | null,
    aiAccounts: AiAccountsForm | null,
  ) => (
    <AiSettingsForm
      aiAccounts={aiAccounts}
      {...(hostClient ? { idleCompaction } : {})}
      onChooseModel={() => {
        if (selection.deploymentId)
          navigation.navigate("NewThread", { deploymentId: selection.deploymentId });
      }}
      backgroundModels={backgroundModels}
      page={page}
      engineUpdates={engineUpdates}
      onEngineUpdate={(environmentId, driverKind) => {
        if (engineUpdate.running) return;
        setEngineUpdateKey(`${environmentId}:${driverKind}`);
        void engineUpdate.run({ environmentId, driverKind });
      }}
    />
  );
  return hostClient === null ? (
    <SettingsPageLayout>{form(null, null)}</SettingsPageLayout>
  ) : (
    <WithHost deploymentId={selection.deploymentId} host={hostClient} key={selection.deploymentId}>
      {form}
    </WithHost>
  );
}

function WithHost(props: {
  readonly children: (
    backgroundModels: BackgroundModelsForm | null,
    aiAccounts: AiAccountsForm,
  ) => ReactNode;
  readonly deploymentId: string | null;
  readonly host: HostClient;
}): ReactNode {
  const backgroundModels = useBackgroundModels(props.host);
  const showTab = useShowTab(props.deploymentId ?? "");
  const accounts = useAiAccounts(props.host, props.deploymentId === null ? undefined : showTab);
  return (
    <>
      <SettingsPageLayout>{props.children(backgroundModels, accounts.form)}</SettingsPageLayout>
      {accounts.sheet}
    </>
  );
}
