import path from "node:path";
import type { App } from "electron";

type ProtocolClientApplication = Pick<App, "setAsDefaultProtocolClient">;

/** Register the exact app invocation required for callbacks in packaged and dev builds. */
export function registerDesktopOAuthProtocolClient(options: {
  readonly application: ProtocolClientApplication;
  readonly defaultApp: boolean | undefined;
  readonly entryArgument: string | undefined;
  readonly executablePath: string;
  readonly scheme: string;
}): void {
  if (!/^[a-z][a-z0-9+.-]*$/u.test(options.scheme)) {
    throw new Error("Desktop OAuth callback scheme is invalid.");
  }
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
