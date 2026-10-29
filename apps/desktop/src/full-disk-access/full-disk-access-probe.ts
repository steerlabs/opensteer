import { spawn as spawnChild, type SpawnOptions } from "node:child_process";

const maximumProbeOutputBytes = 4_096;

export interface FullDiskAccessProbeChild {
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  once(event: "close", listener: (code: number | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type SpawnFullDiskAccessProbe = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => FullDiskAccessProbeChild;

export async function probeFullDiskAccess(
  helperBinary: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly spawn?: SpawnFullDiskAccessProbe;
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Full Disk Access is a macOS setting");
  }

  const spawn: SpawnFullDiskAccessProbe = options.spawn ?? defaultSpawn;
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(helperBinary, ["full-disk-access"], {
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (value: Buffer | string) => {
      stdout = appendBounded(stdout, value);
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      stderr = appendBounded(stderr, value);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const answer = stdout.trim();
      if (code === 0 && answer === "granted") {
        finish(null, true);
        return;
      }
      if (code === 0 && answer === "denied") {
        finish(null, false);
        return;
      }
      const detail = stderr.trim() || `unexpected response ${JSON.stringify(answer)}`;
      finish(new Error(`Full Disk Access probe failed: ${detail}`));
    });

    function finish(error: Error | null, granted?: boolean): void {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(granted === true);
      }
    }
  });
}

function defaultSpawn(
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
): FullDiskAccessProbeChild {
  return spawnChild(executable, arguments_, options);
}

function appendBounded(current: string, value: Buffer | string): string {
  return `${current}${value.toString()}`.slice(0, maximumProbeOutputBytes);
}
