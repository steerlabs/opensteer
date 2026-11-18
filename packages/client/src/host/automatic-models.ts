import { agentHomeSettingsErrorText, type AutomaticModelsView } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import { unwrapRpcResult } from "./host-session-client.js";

export async function getAutomaticModels(
  client: Pick<HostClient, "rpc" | "automaticModelsAvailable">,
) {
  if (!client.automaticModelsAvailable?.()) return null;
  return unwrapRpcResult(await client.rpc["automaticModels.get"]({}));
}
export const backgroundModelsTitle = "Background models";
export const backgroundModelsNote = "Ask your agent to change these.";
export const notUsedForBackgroundWork = "Not used for background work";
const roleTitles = {
  naming: "Task names",
  light: "Memory after chats",
  deep: "Nightly memory",
} as const;
/** One read-only row per background job: what runs it now. */
export function backgroundModelRows(view: AutomaticModelsView) {
  return (["naming", "light", "deep"] as const).map((role) => {
    const inUse = view[role];
    return {
      role,
      title: roleTitles[role],
      detail: inUse
        ? [
            inUse.modelDisplayName,
            inUse.effortDisplayName,
            inUse.accountDisplayName,
            inUse.usageLimited ? "near its usage limit" : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Nothing can run this now",
    };
  });
}
export function backgroundModelsFileError(view: AutomaticModelsView): string | null {
  return view.file.status === "invalid" && view.file.error
    ? `settings.json is invalid, so the last valid version is in use. ${agentHomeSettingsErrorText(view.file.error)}`
    : null;
}
