import { parseAutomaticModelConfig } from "@opensteer/client/host";
import {
  automaticModelsDismissalKey,
  editAutomaticRole,
  getAutomaticModels,
  setAutomaticModels,
} from "@opensteer/client/host";
import type { HostClient } from "@opensteer/client/host";
import { useState, useSyncExternalStore } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";
import type { AutomaticModelsForm } from "./settings-form.types.js";
import { useSettingsRead } from "./use-settings-read.js";
export function useAutomaticModelsForm(host: HostClient): AutomaticModelsForm {
  const notices = useMobileClient().usageNotices;
  const keys = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
  const read = useSettingsRead(host, () => getAutomaticModels(host), "automatic-models");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const snapshot = host.getSnapshot();
  const key = automaticModelsDismissalKey(snapshot.deploymentId ?? "", snapshot.user?.id ?? "");
  const change: AutomaticModelsForm["save"] = (make) => {
    try {
      const config = make();
      setPending(true);
      setFailure(null);
      void setAutomaticModels(host, config)
        .then(
          () => read.reload(),
          (e: unknown) => setFailure(e instanceof Error ? e.message : "Couldn’t save that."),
        )
        .finally(() => setPending(false));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Invalid config");
    }
  };
  return {
    supported: host.automaticModelsAvailable?.() === true,
    view: read.data,
    error: failure ?? read.error,
    pending,
    explanation: keys !== null && !keys.has(key),
    dismiss: () => notices.dismiss(key),
    save: change,
    edit(role, action) {
      if (read.data) change(() => editAutomaticRole(read.data!, role, action));
    },
    toggle(id) {
      if (read.data)
        change(() => {
          const config = parseAutomaticModelConfig(read.data!.config);
          config.excludedAccounts = config.excludedAccounts.includes(id)
            ? config.excludedAccounts.filter((a) => a !== id)
            : [...config.excludedAccounts, id];
          return config;
        });
    },
  };
}
