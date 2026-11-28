import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { isNodeError } from "@opensteer/shared/nodeError";
import { promisify } from "node:util";
import type { PluginExecutionRecord } from "@opensteer/database";

export type EngineProcess = NonNullable<PluginExecutionRecord["engineProcess"]>;

export async function engineProcessNamespace(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await promisify(execFile)("/usr/sbin/sysctl", [
        "-n",
        "kern.bootsessionuuid",
      ]);
      return stdout.trim() || null;
    }
    if (process.platform === "linux") {
      const [bootId, namespace, initStat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readlink("/proc/self/ns/pid"),
        readFile("/proc/1/stat", "utf8"),
      ]);
      const initStart = initStat.slice(initStat.lastIndexOf(")") + 2).split(" ")[19];
      if (initStart) return `${bootId.trim()}:${namespace}:${initStart}`;
    }
  } catch {
    return null;
  }
  return null;
}

export async function engineProcessMachineId(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await promisify(execFile)(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      { timeout: 2_000 },
    );
    const uuid = /"IOPlatformUUID"\s*=\s*"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/iu
      .exec(stdout)?.[1]
      ?.toLowerCase();
    if (uuid && uuid !== "00000000-0000-0000-0000-000000000000")
      return createHash("sha256").update(uuid).digest("hex");
  } catch {
    return null;
  }
  return null;
}

export function engineProcessGroupGone(
  engine: EngineProcess,
  namespace: string | null,
  machineId?: string | null,
): boolean {
  if (!namespace || (engine.machineId && machineId && engine.machineId !== machineId)) return false;
  if (namespace !== engine.namespace) return Boolean(machineId && machineId === engine.machineId);
  try {
    process.kill(-engine.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}
