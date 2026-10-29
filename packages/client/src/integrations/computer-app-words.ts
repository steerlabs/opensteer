import type { ComputerAppPresentationView } from "@opensteer/integration-core";
import { computerAppPlatformTargetLabel } from "./computer-apps.js";
import { addPhoneSteps } from "./computer-use.js";

/**
 * Whether an app runs only on an Android phone. A phone joins Opensteer from a
 * computer it is plugged into, never from itself, so every sentence about
 * where to set such an app up names that computer instead. An app that names
 * no platform this client knows is not known to be a phone's.
 */
export function computerAppRunsOnPhone(
  presentation: Pick<ComputerAppPresentationView, "platforms"> | undefined,
): boolean {
  const platforms = presentation?.platforms ?? [];
  return platforms.length > 0 && platforms.every((platform) => platform === "android");
}

/**
 * Where a computer app has to be turned on, for a surface that cannot do it.
 *
 * The sentence names the computer the app needs — the definition's own fact —
 * never the device the person happens to be reading it on.
 */
export function computerAppElsewhereDetail(input: {
  readonly integrationName: string;
  readonly presentation: Pick<ComputerAppPresentationView, "platforms"> | undefined;
}): string {
  return computerAppRunsOnPhone(input.presentation)
    ? `${addPhoneSteps("an Android phone")} Then return here to allow access.`
    : `Open Opensteer on ${computerAppPlatformTargetLabel(input.presentation?.platforms ?? [])} and turn ${input.integrationName} on for it, then return here to allow access.`;
}
