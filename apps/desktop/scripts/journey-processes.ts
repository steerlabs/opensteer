import { execFileSync } from "node:child_process";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
export const ProcessIdentitySchema = z.object({
  pid: z.number().int().min(2),
  pgid: z.number().int().min(2),
  startedAt: z.string().min(1),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;
export const ProcessSchema = ProcessIdentitySchema.extend({
  pid: z.number(),
  pgid: z.number(),
  ppid: z.number(),
  command: z.string(),
});
export type ProcessRow = z.infer<typeof ProcessSchema>;
export interface ProcessIO {
  processes(): ProcessRow[];
  signal(pid: number, signal: NodeJS.Signals): boolean;
  pause(milliseconds: number): void | Promise<void>;
}
export const realProcessIO: ProcessIO = {
  processes() {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    });
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match =
          /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
        if (!match) throw Error("Unrecognized ps identity row");
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          pgid: Number(match[3]),
          startedAt: match[4]!.replace(/\s+/g, " "),
          command: match[5]!,
        };
      });
  },
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ESRCH" || error.code === "EPERM")
      ))
        throw error;
      return false; // A zombie/unsignalable group is retained until absence is confirmed.
    }
  },
  pause: (milliseconds) => delay(milliseconds),
};
export function sameProcess(identity: ProcessIdentity, row: ProcessIdentity): boolean {
  return (
    row.pid === identity.pid && row.pgid === identity.pgid && row.startedAt === identity.startedAt
  );
}
export function verifiedGroup(group: ProcessIdentity, processes: ProcessRow[]): boolean {
  return group.pid === group.pgid && processes.some((row) => sameProcess(group, row));
}
/** Revalidate before every signal; an absent/reused leader never authorizes signaling an old PGID. */
export async function stopRegisteredGroups(
  registration: { groups: ProcessIdentity[] },
  io: ProcessIO = realProcessIO,
): Promise<string[]> {
  registration.groups.forEach((group) => ProcessIdentitySchema.parse(group));
  if (!registration.groups.length) return [];
  const removed: string[] = [];
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const group of registration.groups)
      if (verifiedGroup(group, io.processes())) {
        if (io.signal(-group.pgid, signal)) removed.push(`${signal}:group:${group.pgid}`);
      }
    await io.pause(signal === "SIGTERM" ? 100 : 50);
  }
  const deadline = Date.now() + 5000;
  let rows = io.processes();
  while (registration.groups.some((g) => verifiedGroup(g, rows)) && Date.now() < deadline) {
    await io.pause(50);
    rows = io.processes();
  }
  registration.groups = registration.groups.filter((group) =>
    rows.some((row) => row.pgid === group.pgid),
  );
  return removed;
}
