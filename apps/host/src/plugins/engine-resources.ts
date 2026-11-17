import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";

export function pluginEngineEntry(from: string): URL {
  const extension = /\.[cm]?[jt]s$/u.exec(new URL(from).pathname)?.[0];
  if (!extension) throw new Error("Cannot locate the plugin engine beside its Host");
  return new URL(`./plugin-engine${extension}`, from);
}

export function pluginEngineUnavailableReason(
  platform: string = process.platform,
  architecture: string = process.arch,
  resolveBinary: () => string = () => {
    const module = createRequire(import.meta.url)("workerd") as { default: string };
    return module.default;
  },
): string | undefined {
  // There is no native Windows arm64 binary; do not silently depend on x64 emulation.
  if (
    !(["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(architecture)) &&
    !(platform === "win32" && architecture === "x64")
  )
    return `Plugins are unavailable: workerd has no binary for ${platform}/${architecture}`;
  try {
    accessSync(resolveBinary(), platform === "win32" ? constants.F_OK : constants.X_OK);
    return undefined;
  } catch {
    return `Plugins are unavailable: the workerd runtime for ${platform}/${architecture} is missing`;
  }
}
