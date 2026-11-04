import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import { harnessDriverLabel } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState, type ReactNode } from "react";
import { operationDetail } from "../client/mobile-client.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AiSettingsForm } from "./settings-ai-form.js";
import { useAutomaticModelsForm } from "./settings-automatic-models.js";
import type { AutomaticModelsForm } from "./settings-form.types.js";
import { engineInstallationUpdateModel } from "./settings-model.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useSettingsHost } from "./use-settings-host.js";
export function AiSettingsController(): ReactNode {
  const page = "ai";
  const navigation = useNavigation();
  const { selection } = useMobileState();
  const [engineUpdatePending, setEngineUpdatePending] = useState<string | null>(null);
  const [engineUpdateError, setEngineUpdateError] = useState<{
    detail: string;
    key: string;
  } | null>(null);
  const snapshot = useSettingsHost(selection.hostClient);
  const engineUpdates = useMemo(() => {
    if (snapshot === null) return [];
    return snapshot.engineInstallations.map(({ driverKind, environmentId, installation }) => {
      const key = `${environmentId}:${driverKind}`;
      const model = engineInstallationUpdateModel(installation, key === engineUpdatePending);
      return {
        detail: engineUpdateError?.key === key ? engineUpdateError.detail : model.detail,
        driverKind,
        environmentId,
        key,
        name: harnessDriverLabel(driverKind),
        updateEnabled: snapshot.harnessUpdateAvailable && model.updateEnabled,
        updating: model.updating,
      };
    });
  }, [engineUpdateError, engineUpdatePending, snapshot]);
  const hostClient = selection.hostClient;
  const form = (automatic: AutomaticModelsForm | null) => (
    <AiSettingsForm
      onChooseModel={() => {
        if (selection.deploymentId)
          navigation.navigate("NewThread", { deploymentId: selection.deploymentId });
      }}
      automatic={automatic}
      page={page}
      engineUpdates={engineUpdates}
      onEngineUpdate={(environmentId, driverKind) => {
        const hostClient = selection.hostClient;
        if (!hostClient || engineUpdatePending) return;
        const key = `${environmentId}:${driverKind}`;
        setEngineUpdatePending(key);
        setEngineUpdateError(null);
        void hostClient
          .dispatch({
            driverKind,
            environmentId,
            idempotencyKey: mutationIdempotencyKey(`harness-update:${key}`),
            type: "harness.update",
          })
          .then(() => hostClient.refresh())
          .catch((error: unknown) =>
            setEngineUpdateError({
              detail: operationDetail(error, "Update failed. Try again."),
              key: `${environmentId}:${driverKind}`,
            }),
          )
          .finally(() => setEngineUpdatePending(null));
      }}
    />
  );
  return (
    <SettingsPageLayout>
      {hostClient === null ? (
        form(null)
      ) : (
        <WithAutomaticModels host={hostClient} key={selection.deploymentId}>
          {form}
        </WithAutomaticModels>
      )}
    </SettingsPageLayout>
  );
}

function WithAutomaticModels(props: {
  readonly children: (automatic: AutomaticModelsForm) => ReactNode;
  readonly host: HostClient;
}): ReactNode {
  return props.children(useAutomaticModelsForm(props.host));
}
