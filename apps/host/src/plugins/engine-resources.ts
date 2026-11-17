import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

export function pluginEngineEntry(from: string): URL {
  const extension = /\.[cm]?[jt]s$/u.exec(new URL(from).pathname)?.[0];
  if (!extension) throw new Error("Cannot locate the plugin engine beside its Host");
  return new URL(`./plugin-engine${extension}`, from);
}

export async function pluginEngineUnavailableReason(
  platform: string = process.platform,
  architecture: string = process.arch,
  resolveBinary: () => string = () => {
    const module = createRequire(import.meta.url)("workerd") as { default: string };
    return module.default;
  },
): Promise<string | undefined> {
  // There is no native Windows arm64 binary; do not silently depend on x64 emulation.
  if (
    !(["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(architecture)) &&
    !(platform === "win32" && architecture === "x64")
  )
    return `Plugins are unavailable: workerd has no binary for ${platform}/${architecture}`;
  try {
    const binary = resolveBinary();
    await access(binary, platform === "win32" ? constants.F_OK : constants.X_OK);
    try {
      await promisify(execFile)(binary, ["--version"], {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 4_096,
      });
    } catch {
      return `Plugins are unavailable: workerd cannot run on this ${platform}/${architecture} system`;
    }
    return undefined;
  } catch {
    return `Plugins are unavailable: the workerd runtime for ${platform}/${architecture} is missing`;
  }
}
