import { getAutomaticModels, type HostClient } from "@opensteer/client/host";
import type { BackgroundModelsForm } from "./settings-form.types.js";
import { useSettingsRead } from "./use-settings-read.js";

export function useBackgroundModels(host: HostClient): BackgroundModelsForm | null {
  const read = useSettingsRead(host, () => getAutomaticModels(host), "automatic-models");
  if (host.automaticModelsAvailable?.() !== true) return null;
  return { view: read.data, error: read.error };
}
