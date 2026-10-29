import { hiddenDesktopLaunchArgument } from "../supervisor/open-at-login.js";

/**
 * A packaged Opensteer starts only the way macOS, its own login item and its
 * callback links start it. Anything running as the person can relaunch the
 * signed app with Chromium switches that expose every page over a debugging
 * port, route its traffic through a proxy, accept forged certificates or log
 * TLS keys; Electron honours those switches and its fuses cover only Node's.
 * Refusing every argument the app did not define closes that whole class
 * instead of chasing individual switch names. Development launches are left
 * to the developer.
 */
export function assertDesktopLaunch(input: {
  readonly argv: readonly string[];
  readonly callbackScheme: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly packaged: boolean;
}): void {
  if (!input.packaged) return;
  if (input.environment.SSLKEYLOGFILE !== undefined) {
    throw new Error(
      "Opensteer can’t start while SSLKEYLOGFILE is set, because Chromium would write this app’s encryption keys to that file. Unset it and open Opensteer again.",
    );
  }
  const callbackPrefix = `${input.callbackScheme}:`;
  for (const argument of input.argv.slice(1)) {
    if (argument === hiddenDesktopLaunchArgument) continue;
    if (!argument.startsWith("-") && argument.toLowerCase().startsWith(callbackPrefix)) continue;
    if (argument === "--no-sandbox") {
      throw new Error(
        "Opensteer can’t start because this launcher disabled the Chromium sandbox. Install the native package or enable unprivileged user namespaces; --no-sandbox is never accepted.",
      );
    }
    throw new Error(
      `Opensteer doesn’t accept the launch option ${describeArgument(argument)}. Open Opensteer from Applications instead.`,
    );
  }
}

function describeArgument(argument: string): string {
  const name = argument.split("=", 1)[0] ?? argument;
  return name.length > 80 ? `${name.slice(0, 80)}…` : name;
}
