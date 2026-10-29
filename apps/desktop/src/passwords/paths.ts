import { homedir } from "node:os";
import path from "node:path";

/**
 * Release and development brokers are two separate apps: their own bundle id,
 * install root, socket, lock and vault. A development build exists to hold test
 * data, so nothing about it may ever reach the person's real vault.
 */
export const passwordsBrokerAppName = "Opensteer Passwords.app";
export const passwordsBrokerExecutableName = "Opensteer Passwords";
export const passwordsReleaseBrokerBundleId = "com.opensteer.passwords";
export const passwordsDevelopmentBrokerBundleId = "com.opensteer.passwords.dev";

export function passwordsBrokerBundleId(development: boolean): string {
  return development ? passwordsDevelopmentBrokerBundleId : passwordsReleaseBrokerBundleId;
}

/**
 * The canonical install root. Stable and Beta share the release one, as they
 * share the computer use helper's: one vault per Mac user, served by the
 * newest installed broker.
 */
export function passwordsBrokerRoot(development: boolean, homeDirectory = homedir()): string {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Opensteer",
    development ? "Passwords (Development)" : "Passwords",
  );
}

export function passwordsBrokerAppPath(development: boolean, homeDirectory?: string): string {
  return path.join(passwordsBrokerRoot(development, homeDirectory), passwordsBrokerAppName);
}

/** The socket the broker listens on, inside the 0700 root above. */
export function passwordsBrokerSocketPath(development: boolean, homeDirectory?: string): string {
  return path.join(passwordsBrokerRoot(development, homeDirectory), "ipc.sock");
}

/** The kernel `flock` every install and launch holds through socket readiness. */
export function passwordsBrokerLockPath(development: boolean, homeDirectory?: string): string {
  return path.join(passwordsBrokerRoot(development, homeDirectory), "lifecycle.lock");
}

/**
 * Where this build keeps the broker it would install: beside the other native
 * resources when packaged, the Swift package's build output in development.
 * A development checkout that has not built it gets a sentence, never a
 * silent skip.
 */
export function bundledPasswordsBrokerPath(input: {
  readonly developmentRoot: string;
  readonly packaged: boolean;
  readonly resourcesPath: string | undefined;
}): string {
  if (input.packaged) {
    if (!input.resourcesPath) {
      throw new Error("A packaged desktop app must know its resources directory.");
    }
    return path.join(input.resourcesPath, "passwords", passwordsBrokerAppName);
  }
  return path.join(
    input.developmentRoot,
    "apps",
    "desktop",
    "native",
    "passwords",
    "dist",
    passwordsBrokerAppName,
  );
}

export const passwordsBrokerNotBuiltMessage =
  "Opensteer Passwords is not built; run pnpm --filter desktop build:passwords-broker.";
