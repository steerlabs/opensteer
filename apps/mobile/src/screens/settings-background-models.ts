import {
  backgroundConsentDismissalKey,
  backgroundModelsSettings,
  dismissedBackgroundProviders,
  getBackgroundModels,
  setBackgroundModelRole,
  setBackgroundProviderConsent,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import { useState, useSyncExternalStore } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";
import type { BackgroundModelsForm } from "./settings-form.types.js";
import { useSettingsRead } from "./use-settings-read.js";

/** Settings' background models for the open Host: read on entry, again after each change. */
export function useBackgroundModelsForm(host: HostClient): BackgroundModelsForm {
  const notices = useMobileClient().backgroundNotices;
  const keys = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
  const read = useSettingsRead(
    host,
    async () => unwrapRpcResult(await getBackgroundModels(host)),
    "background-models",
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const snapshot = host.getSnapshot();
  const scope =
    snapshot.deploymentId && snapshot.user
      ? { deploymentId: snapshot.deploymentId, userId: snapshot.user.id }
      : null;
  const settings =
    read.data === null
      ? null
      : backgroundModelsSettings(
          read.data,
          scope ? dismissedBackgroundProviders(keys, scope) : null,
        );
  const change = (mutation: () => ReturnType<typeof setBackgroundProviderConsent>) => {
    setPending(true);
    setFailure(null);
    void mutation()
      .then(unwrapRpcResult)
      .then(read.reload, () => setFailure("Couldn’t save that. Try again."))
      .finally(() => setPending(false));
  };
  return {
    settings,
    error: failure ?? read.error,
    pending,
    onRole(role, value) {
      const choice = settings?.roles
        .find((item) => item.role === role)
        ?.choices.find((item) => item.value === value);
      if (choice) change(() => setBackgroundModelRole(host, role, choice.mode));
    },
    onConsent(providerId, allowed) {
      change(() => setBackgroundProviderConsent(host, providerId, allowed));
    },
    onNotNow(providerId) {
      if (scope) notices.dismiss(backgroundConsentDismissalKey({ ...scope, providerId }));
    },
  };
}
