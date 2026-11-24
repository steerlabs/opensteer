import path from "node:path";
import type { App } from "electron";

type ProtocolClientApplication = Pick<App, "setAsDefaultProtocolClient">;

/**
 * Register the exact app invocation required for callbacks in packaged and dev builds.
 *
 * A trial (`config.ts`) registers nothing. Its scheme is the installed Opensteer's, and on a Mac
 * Launch Services keeps one default handler per scheme, which `setAsDefaultProtocolClient` sets
 * to the running app's bundle whatever path it is given: taking it would send the installed app's
 * sign-in callbacks to this build's Electron, still after it quits. A trial has no Opensteer
 * account to sign in to.
 */
export function registerDesktopOAuthProtocolClient(options: {
  readonly application: ProtocolClientApplication;
  readonly defaultApp: boolean | undefined;
  readonly entryArgument: string | undefined;
  readonly executablePath: string;
  readonly scheme: string;
  readonly trial: boolean;
}): void {
  if (!/^[a-z][a-z0-9+.-]*$/u.test(options.scheme)) {
    throw new Error("Desktop OAuth callback scheme is invalid.");
  }
  if (options.trial) return;
  const registered = options.defaultApp
    ? options.entryArgument
      ? options.application.setAsDefaultProtocolClient(options.scheme, options.executablePath, [
          path.resolve(options.entryArgument),
        ])
      : false
    : options.application.setAsDefaultProtocolClient(options.scheme);
  if (!registered) {
    throw new Error("Opensteer could not register its secure OAuth callback protocol.");
  }
}
