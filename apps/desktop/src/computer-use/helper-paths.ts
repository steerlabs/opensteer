import { homedir } from "node:os";
import path from "node:path";

/** The one name macOS shows for the helper, in the Finder and in both grants. */
export const computerUseHelperAppName = "Opensteer Computer Use.app";
export const computerUseHelperBundleId = "com.opensteer.computer-use";
export const computerUseHelperExecutableName = "Opensteer Computer Use";

export function computerUseHelperExecutablePath(appPath: string): string {
  return path.join(appPath, "Contents", "MacOS", computerUseHelperExecutableName);
}

/**
 * The canonical install root, shared by every Opensteer that installs a helper.
 *
 * Stable and Beta refresh one path so the two apps share one grant: macOS keys
 * Accessibility and Screen Recording on the bundle it granted them to, and a
 * second copy under a second app's data directory would be a second row in
 * System Settings for the same feature.
 */
export function computerUseHelperRoot(homeDirectory: string = homedir()): string {
  return path.join(homeDirectory, "Library", "Application Support", "Opensteer", "Computer Use");
}

export function computerUseHelperAppPath(homeDirectory?: string): string {
  return path.join(computerUseHelperRoot(homeDirectory), computerUseHelperAppName);
}

/** The socket the helper listens on, inside the 0700 root above. */
export function computerUseHelperSocketPath(homeDirectory?: string): string {
  return path.join(computerUseHelperRoot(homeDirectory), "ipc.sock");
}

/**
 * The lifecycle lock, an OS lock on this file. It is not the `install.lock`
 * an earlier Opensteer used: that one deletes its file once the file looks
 * old, and deleting a file somebody holds a lock on is what lets two holders in.
 */
export function computerUseHelperLockPath(homeDirectory?: string): string {
  return path.join(computerUseHelperRoot(homeDirectory), "lifecycle.lock");
}

/**
 * Where this build keeps the helper it would install.
 *
 * Packaged: beside the other native resources, exactly as the native
 * filesystem helper is resolved. Development: the Swift package's own build
 * output, which is missing until somebody builds it — that case is an error
 * with a sentence, never a silent skip, because a desktop that quietly has no
 * helper looks like a Mac that cannot do computer use.
 */
export function bundledComputerUseHelperPath(input: {
  readonly developmentRoot: string;
  readonly packaged: boolean;
  readonly resourcesPath: string | undefined;
}): string {
  if (input.packaged) {
    if (!input.resourcesPath) {
      throw new Error("A packaged desktop app must know its resources directory.");
    }
    return path.join(input.resourcesPath, "computer-use", computerUseHelperAppName);
  }
  return path.join(
    input.developmentRoot,
    "apps",
    "desktop",
    "native",
    "computer-use",
    "dist",
    computerUseHelperAppName,
  );
}

export const computerUseHelperNotBuiltMessage =
  "Computer use helper is not built; run pnpm --filter desktop build:computer-use-helper.";
