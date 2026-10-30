import { homedir } from "node:os";
import path from "node:path";

export const dictationBrokerAppName = "Opensteer Dictation.app";
export const dictationBrokerExecutableName = "Opensteer Dictation";
export const dictationReleaseBrokerBundleId = "com.opensteer.dictation";
export const dictationDevelopmentBrokerBundleId = "com.opensteer.dictation.dev";

export function dictationBrokerBundleId(development: boolean): string {
  return development ? dictationDevelopmentBrokerBundleId : dictationReleaseBrokerBundleId;
}

export function dictationBrokerRoot(development: boolean, homeDirectory = homedir()): string {
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Opensteer",
    development ? "Dictation (Development)" : "Dictation",
  );
}

export function dictationBrokerAppPath(development: boolean, homeDirectory?: string): string {
  return path.join(dictationBrokerRoot(development, homeDirectory), dictationBrokerAppName);
}

export function dictationBrokerSocketPath(development: boolean, homeDirectory?: string): string {
  return path.join(dictationBrokerRoot(development, homeDirectory), "ipc.sock");
}

export function dictationBrokerLockPath(development: boolean, homeDirectory?: string): string {
  return path.join(dictationBrokerRoot(development, homeDirectory), "lifecycle.lock");
}

export function bundledDictationBrokerPath(input: {
  readonly developmentRoot: string;
  readonly packaged: boolean;
  readonly resourcesPath: string | undefined;
}): string {
  if (input.packaged) {
    if (!input.resourcesPath) {
      throw new Error("A packaged desktop app must know its resources directory.");
    }
    return path.join(input.resourcesPath, "dictation", dictationBrokerAppName);
  }
  return path.join(
    input.developmentRoot,
    "apps",
    "desktop",
    "native",
    "dictation",
    "dist",
    dictationBrokerAppName,
  );
}

export const dictationBrokerNotBuiltMessage =
  "Opensteer Dictation is not built; run pnpm --filter desktop build:dictation-helper.";
