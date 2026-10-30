export const signedMacHelpers = [
  { script: "build-passwords-broker.ts", command: "build:passwords-broker" },
  { script: "build-dictation-helper.ts", command: "build:dictation-helper" },
] as const;

const ciDeveloperDirectory = "/Applications/Xcode_26.3.app/Contents/Developer";

export async function selectDictationSDK(
  sdkVersion: (environment: NodeJS.ProcessEnv) => Promise<string>,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  for (const developer of [environment.DEVELOPER_DIR, ciDeveloperDirectory]) {
    const selection = developer ? { DEVELOPER_DIR: developer } : {};
    try {
      const version = (await sdkVersion({ ...environment, ...selection })).trim();
      if (/^\d+(?:\.\d+)*$/u.test(version) && Number(version.split(".")[0]) >= 26) return selection;
    } catch {
      signal?.throwIfAborted();
      // Try the same Xcode installation selected by the release workflow.
    }
  }
  throw new Error(
    "The macOS 26 SDK is required for dictation. Install Xcode 26 or set DEVELOPER_DIR to an Xcode with the macOS 26 SDK.",
  );
}
