import { getAutomaticModels, type HostClient } from "@opensteer/client/host";
import { readLine, settingsFooter, useScreenRead } from "../ui/client-feedback.js";
import type { BackgroundModelsForm } from "./settings-form.types.js";

export function useBackgroundModels(host: HostClient): BackgroundModelsForm | null {
  const available = host.automaticModelsAvailable?.() === true;
  const read = useScreenRead(host, {
    key: "automatic-models",
    label: "background models",
    read: available ? () => getAutomaticModels(host) : null,
  });
  if (!available) return null;
  return { view: read.data, line: settingsFooter(readLine(read, read.refresh)) ?? null };
}
