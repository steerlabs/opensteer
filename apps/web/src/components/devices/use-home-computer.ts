import { computerGlyph, hostsDeployment } from "@opensteer/client/computers";
import { useShell } from "../app-shell.js";
import { computerIcon } from "../computers/device-art.js";
import type { IconName } from "../icon.js";

export function useHomeComputer(): { readonly icon: IconName; readonly name: string | null } {
  const { snapshot } = useShell();
  const home = snapshot.machines.find(hostsDeployment);
  return {
    icon: home ? computerIcon(computerGlyph(home)) : "desktop",
    name: home?.name ?? null,
  };
}
