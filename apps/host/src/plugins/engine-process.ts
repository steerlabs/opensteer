import { execFile } from "node:child_process";
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

export function engineProcessGroupGone(engine: EngineProcess, namespace: string | null): boolean {
  if (!namespace || namespace !== engine.namespace) return false;
  try {
    process.kill(-engine.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}
