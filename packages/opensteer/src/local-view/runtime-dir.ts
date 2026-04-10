import { homedir } from "node:os";
import path from "node:path";

export function resolveOpensteerStateDir(): string {
  const explicit = process.env.OPENSTEER_HOME?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "Opensteer",
    );
  }

  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Opensteer");
  }

  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
    "opensteer",
  );
}

export function resolveLocalViewRootDir(): string {
  return path.join(resolveOpensteerStateDir(), "local-view");
}

export function resolveLocalViewServiceDir(): string {
  return path.join(resolveLocalViewRootDir(), "service");
}

export function resolveLocalViewSessionsDir(): string {
  return path.join(resolveLocalViewRootDir(), "sessions");
}

export function resolveLocalViewServiceLockDir(): string {
  return path.join(resolveLocalViewServiceDir(), "startup.lock");
}

export function resolveLocalViewServiceStatePath(): string {
  return path.join(resolveLocalViewServiceDir(), "state.json");
}
