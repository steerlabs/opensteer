import { homedir } from "node:os";
import {
  ensureSignedHelperInstalled,
  type InstalledSignedHelper,
  type SignedHelperDeadline,
  type SignedHelperIdentity,
  type SignedHelperProcess,
} from "../signed-helpers/signed-helper.js";

import {
  dictationBrokerAppName,
  dictationBrokerAppPath,
  dictationBrokerBundleId,
  dictationBrokerExecutableName,
  dictationBrokerLockPath,
  dictationBrokerNotBuiltMessage,
  dictationBrokerRoot,
} from "./paths.js";
import { desktopDictationTeamId, dictationBrokerRequirement } from "./release-identity.js";

export function dictationBrokerIdentity(development: boolean): SignedHelperIdentity {
  return {
    appName: dictationBrokerAppName,
    bundleId: dictationBrokerBundleId(development),
    executableName: dictationBrokerExecutableName,
    label: "Opensteer Dictation",
    lockBusy: () =>
      new Error(
        "Another Opensteer is starting or updating Opensteer Dictation. Try again shortly.",
      ),
    logPrefix: "desktop.dictation.broker",
    notBuiltMessage: dictationBrokerNotBuiltMessage,
    peerLabel: "Opensteer Dictation",
    requirement: (teamId) => dictationBrokerRequirement(development, teamId),
    unsupportedPlatformMessage: "Opensteer Dictation runs only on macOS.",
  };
}

export interface EnsureDictationBrokerInstalledOptions {
  readonly bundledAppPath: string;
  readonly deadline: SignedHelperDeadline;
  readonly development: boolean;
  readonly homeDirectory?: string;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  readonly run?: SignedHelperProcess;
}

export async function ensureDictationBrokerInstalled(
  options: EnsureDictationBrokerInstalledOptions,
): Promise<InstalledSignedHelper> {
  const home = options.homeDirectory ?? homedir();
  return await ensureSignedHelperInstalled({
    bundledAppPath: options.bundledAppPath,
    deadline: options.deadline,
    identity: dictationBrokerIdentity(options.development),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.now === undefined ? {} : { now: options.now }),
    paths: {
      app: dictationBrokerAppPath(options.development, home),
      lock: dictationBrokerLockPath(options.development, home),
      root: dictationBrokerRoot(options.development, home),
    },
    ...(options.run === undefined ? {} : { run: options.run }),
    teamId: desktopDictationTeamId(options.development),
  });
}
