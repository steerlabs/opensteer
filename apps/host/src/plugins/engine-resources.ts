import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
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
  signal?: AbortSignal,
): Promise<PluginEngineUnavailability | undefined> {
  // There is no native Windows arm64 binary; do not silently depend on x64 emulation.
  if (
    !(["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(architecture)) &&
    !(platform === "win32" && architecture === "x64")
  )
    return {
      code: "unsupported-system",
      detail: `Plugins are unavailable: workerd has no binary for ${platform}/${architecture}`,
    };
  try {
    const binary = resolveBinary();
    await access(binary, platform === "win32" ? constants.F_OK : constants.X_OK);
    const minimumMacOS = platform === "darwin" ? await binaryMinimumMacOS(binary) : undefined;
    try {
      signal?.throwIfAborted();
      const running = promisify(execFile)(binary, ["--version"], {
        timeout: 5_000,
        signal,
        windowsHide: true,
        maxBuffer: 4_096,
      });
      const force = setTimeout(() => running.child.kill("SIGKILL"), 7_000).unref();
      const closed = new Promise<void>((resolve) =>
        running.child.once("close", () => {
          clearTimeout(force);
          resolve();
        }),
      );
      try {
        await running;
      } finally {
        await closed;
      }
    } catch {
      return {
        code: "unsupported-system",
        ...(minimumMacOS ? { minimumMacOS } : {}),
        detail: `Plugins are unavailable: workerd cannot run on this ${platform}/${architecture} system`,
      };
    }
    return undefined;
  } catch {
    return {
      code: "missing-runtime",
      detail: `Plugins are unavailable: the workerd runtime for ${platform}/${architecture} is missing`,
    };
  }
}

export interface PluginEngineUnavailability {
  code: "unsupported-system" | "missing-runtime";
  minimumMacOS?: string;
  detail: string;
}

/** Read the executable's declared deployment floor without loading its code. */
export async function binaryMinimumMacOS(path: string): Promise<string | undefined> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < 32 || header.readUInt32LE(0) !== 0xfeedfacf) return undefined;
    let offset = 32;
    for (let index = 0; index < header.readUInt32LE(16) && offset + 8 <= bytesRead; index++) {
      const command = header.readUInt32LE(offset);
      const size = header.readUInt32LE(offset + 4);
      if (size < 8 || offset + size > bytesRead) return undefined;
      const versionOffset = command === 0x32 ? 12 : command === 0x24 ? 8 : undefined;
      if (versionOffset !== undefined && size >= versionOffset + 4) {
        const version = header.readUInt32LE(offset + versionOffset);
        return [version >>> 16, (version >>> 8) & 255, version & 255].join(".");
      }
      offset += size;
    }
    return undefined;
  } finally {
    await file.close();
  }
}
