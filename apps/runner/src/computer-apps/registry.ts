import {
  computerUseDataApps,
  type ComputerUseDataAppId,
  type ComputerUsePermissions,
} from "@opensteer/protocol";
import { createHelperAppProvider, type HelperDataPort } from "./helper-app-provider.js";
import { createMacosAppProvider } from "./macos-app-provider.js";
import type { ComputerAppProvider } from "./provider.js";

/** Providers are code shipped by this Runner, never definitions learned from a Host. */
export function computerAppProviders(
  platform: NodeJS.Platform,
  options: {
    /**
     * The bridge's `permissions.get`, present only when the desktop app
     * supervises this Runner. Computer use is registered either way: a Mac
     * without the desktop app reports the feature as unavailable rather than
     * leaving the definition out of the status frame, which a client would
     * read as a Mac still being asked.
     */
    readonly computerUsePermissions?: () => Promise<ComputerUsePermissions>;
    /**
     * The helper's data plane, present exactly when `computerUsePermissions`
     * is. The apps it serves are registered either way, for the same reason.
     */
    readonly helperData?: HelperDataPort;
  },
): readonly ComputerAppProvider[] {
  return [
    createMacosAppProvider(
      options.computerUsePermissions ? { permissions: options.computerUsePermissions } : {},
    ),
    ...(Object.keys(computerUseDataApps) as ComputerUseDataAppId[]).map((definitionId) =>
      createHelperAppProvider(definitionId, options.helperData ?? null),
    ),
  ].filter((provider) => provider.platforms.includes(platform));
}
