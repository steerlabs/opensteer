import { homedir } from "node:os";
import {
  ensureSignedHelperInstalled,
  type InstalledSignedHelper,
  type SignedHelperDeadline,
  type SignedHelperIdentity,
  type SignedHelperProcess,
} from "../signed-helpers/signed-helper.js";
import { PasswordsBrokerFailure } from "./broker-session.js";
import {
  passwordsBrokerAppName,
  passwordsBrokerAppPath,
  passwordsBrokerBundleId,
  passwordsBrokerExecutableName,
  passwordsBrokerLockPath,
  passwordsBrokerNotBuiltMessage,
  passwordsBrokerRoot,
} from "./paths.js";
import { desktopPasswordsTeamId, passwordsBrokerRequirement } from "./release-identity.js";

/** `Opensteer Passwords.app` of one build, as the shared install, lock and launch steps name it. */
export function passwordsBrokerIdentity(development: boolean): SignedHelperIdentity {
  return {
    appName: passwordsBrokerAppName,
    bundleId: passwordsBrokerBundleId(development),
    executableName: passwordsBrokerExecutableName,
    label: "Opensteer Passwords",
    lockBusy: () =>
      new PasswordsBrokerFailure(
        "not-running",
        "Another Opensteer is starting or updating Opensteer Passwords. Try again shortly.",
      ),
    logPrefix: "desktop.passwords.broker",
    notBuiltMessage: passwordsBrokerNotBuiltMessage,
    peerLabel: "Opensteer Passwords",
    requirement: (teamId) => passwordsBrokerRequirement(development, teamId),
    unsupportedPlatformMessage: "Opensteer Passwords runs only on macOS.",
  };
}

export interface EnsurePasswordsBrokerInstalledOptions {
  /** The broker this build ships, already resolved for packaged/development. */
  readonly bundledAppPath: string;
  /** How long waiting for the lifecycle lock may take. */
  readonly deadline: SignedHelperDeadline;
  readonly development: boolean;
  readonly homeDirectory?: string;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  readonly run?: SignedHelperProcess;
}

/**
 * Puts this build's broker at its canonical path when it is absent, invalid or
 * older, exactly as the computer use helper is installed: verified, copied
 * with `ditto --noqtn`, verified again where it lands, and swapped in under the
 * lifecycle lock after the staged copy's `--prepare-replacement` asked the
 * running one to quit. Each build only ever looks at its own root, so the
 * development broker never replaces the release one, or the reverse.
 */
export async function ensurePasswordsBrokerInstalled(
  options: EnsurePasswordsBrokerInstalledOptions,
): Promise<InstalledSignedHelper> {
  const home = options.homeDirectory ?? homedir();
  return await ensureSignedHelperInstalled({
    bundledAppPath: options.bundledAppPath,
    deadline: options.deadline,
    identity: passwordsBrokerIdentity(options.development),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.now === undefined ? {} : { now: options.now }),
    paths: {
      app: passwordsBrokerAppPath(options.development, home),
      lock: passwordsBrokerLockPath(options.development, home),
      root: passwordsBrokerRoot(options.development, home),
    },
    ...(options.run === undefined ? {} : { run: options.run }),
    teamId: desktopPasswordsTeamId(options.development),
  });
}
