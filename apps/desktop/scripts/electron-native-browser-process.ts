import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";

const runFile = promisify(execFile);

/** The caller starts a detached process group belonging only to this case. */
export async function watchNativeCaseProcess(
  child: ChildProcess,
  deadlineMs: number,
  onTimeout: () => void,
) {
  const identities = new Map<number, string>();
  const postgresPids = new Set<number>();
  const postgresShutdowns: { pid: number; started: string; signal: "SIGINT" }[] = [];
  const signals: { pid: number; signal: NodeJS.Signals; group: boolean }[] = [];
  const inspectionErrors: string[] = [];
  let timedOut = false;
  let spawnError: string | undefined;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (exited) resolve({ code: child.exitCode, signal: child.signalCode });
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      exited = true;
      spawnError = error.message;
      resolve({ code: null, signal: null });
    });
  });
  const inventory = async () => {
    const { stdout } = await runFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,comm="], {
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C" },
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!inspectionErrors.includes(message)) inspectionErrors.push(message);
      throw error;
    });
    return stdout.split("\n").flatMap((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              identity: match[4]!,
              command: match[5]!,
            },
          ]
        : [];
    });
  };
  const discover = async () => {
    const rows = await inventory();
    const root = rows.find((row) => row.pid === child.pid);
    if (!exited && root && !identities.has(root.pid)) identities.set(root.pid, root.identity);
    for (const row of rows)
      if (row.group === child.pid && !identities.has(row.pid))
        identities.set(row.pid, row.identity);
    let added = true;
    while (added) {
      added = false;
      for (const row of rows) {
        const parent = rows.find((candidate) => candidate.pid === row.parent);
        if (!identities.has(row.pid) && parent && identities.get(parent.pid) === parent.identity) {
          identities.set(row.pid, row.identity);
          added = true;
        }
      }
    }
    const owned = rows.filter((row) => identities.get(row.pid) === row.identity);
    for (const row of owned)
      if (/^(?:\.real-)?(?:postgres|postmaster)(?::.*)?$/.test(path.basename(row.command)))
        postgresPids.add(row.pid);
    return owned;
  };
  let scanning = Promise.resolve();
  let scanPending = false;
  const scan = () => {
    if (scanPending) return;
    scanPending = true;
    scanning = discover()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        scanPending = false;
      });
  };
  scan();
  const poll = setInterval(scan, 250);
  const signalOwned = async (signal: NodeJS.Signals) => {
    const rows = await discover().catch(() => []);
    if (child.pid && (!exited || rows.some((row) => row.group === child.pid))) {
      try {
        process.kill(-child.pid, signal);
        signals.push({ pid: child.pid, signal, group: true });
      } catch {
        /* The entire owned group may already have exited. */
      }
    }
    for (const row of rows.reverse()) {
      try {
        process.kill(row.pid, signal);
        signals.push({ pid: row.pid, signal, group: false });
      } catch {
        /* A descendant can exit between inventory and signal. */
      }
    }
  };
  const stopPostgres = async () => {
    const rows = await discover();
    const postgres = rows.filter((row) => postgresPids.has(row.pid));
    for (const row of postgres.filter(
      (row) => !postgres.some((parent) => parent.pid === row.parent),
    )) {
      try {
        // Fast shutdown closes client connections and removes PostgreSQL's IPC
        // before its supervisor or process group can be force-killed.
        process.kill(row.pid, "SIGINT");
        signals.push({ pid: row.pid, signal: "SIGINT", group: false });
        postgresShutdowns.push({ pid: row.pid, started: row.identity, signal: "SIGINT" });
      } catch (error) {
        if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
      }
    }
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      if (!(await discover()).some((row) => postgresPids.has(row.pid))) return;
      await delay(50);
    }
  };
  let terminate: Promise<void> | undefined;
  const stop = () => {
    terminate ??= (async () => {
      await stopPostgres().catch((error: unknown) => inspectionErrors.push(String(error)));
      await signalOwned("SIGTERM").catch(() => {
        if (!exited) child.kill("SIGTERM");
      });
      await delay(2000);
      // A still-running supervisor may have restarted PostgreSQL during the
      // first shutdown. Discover and drain that owned instance as well.
      await stopPostgres().catch((error: unknown) => inspectionErrors.push(String(error)));
      await signalOwned("SIGKILL").catch(() => {
        if (!exited) child.kill("SIGKILL");
      });
    })();
    return terminate;
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    onTimeout();
    void stop();
  }, deadlineMs);
  let hardDeadline: NodeJS.Timeout | undefined;
  const hardExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      hardDeadline = setTimeout(() => {
        timedOut = true;
        void stop().then(() => resolve({ code: child.exitCode, signal: child.signalCode }));
      }, deadlineMs + 10_000);
      hardDeadline.unref();
    },
  );
  try {
    // A killed leader can leave inherited pipes open. Await exit, not close.
    const outcome = await Promise.race([exit, hardExit]);
    clearTimeout(deadline);
    clearInterval(poll);
    await scanning;
    if (terminate) await terminate;
    let survivors = await discover().catch(() => []);
    if (survivors.length) {
      await stop();
      await delay(100);
      survivors = await discover().catch(() => survivors);
    }
    const postgresCleanup = {
      ownedPids: [...postgresPids],
      shutdowns: postgresShutdowns,
      inspected: process.platform === "darwin",
      before: [] as { id: number; creatorPid: number; attachments: number }[],
      removed: [] as number[],
      remaining: [] as { id: number; creatorPid: number; attachments: number }[],
    };
    if (postgresCleanup.inspected) {
      const segments = async () => {
        const { stdout } = await runFile("/usr/bin/ipcs", ["-m", "-o", "-p"], {
          timeout: 2000,
        });
        return stdout.split("\n").flatMap((line) => {
          const fields = line.trim().split(/\s+/);
          if (fields[0] !== "m") return [];
          return [
            z
              .object({
                id: z.coerce.number().int().nonnegative(),
                creatorPid: z.coerce.number().int().positive(),
                attachments: z.coerce.number().int().nonnegative(),
              })
              .parse({ id: fields[1], creatorPid: fields[7], attachments: fields[6] }),
          ];
        });
      };
      try {
        postgresCleanup.before = (await segments()).filter((row) =>
          postgresPids.has(row.creatorPid),
        );
        for (const segment of postgresCleanup.before) {
          const current = (await segments()).find((row) => row.id === segment.id);
          if (
            !current ||
            !postgresPids.has(current.creatorPid) ||
            current.attachments !== 0 ||
            (await inventory()).some((row) => row.pid === current.creatorPid)
          )
            continue;
          await runFile("/usr/bin/ipcrm", ["-m", String(current.id)], { timeout: 2000 });
          postgresCleanup.removed.push(current.id);
        }
        postgresCleanup.remaining = (await segments()).filter((row) =>
          postgresPids.has(row.creatorPid),
        );
        if (postgresCleanup.remaining.length)
          inspectionErrors.push(
            `Owned PostgreSQL System V segments remain: ${JSON.stringify(postgresCleanup.remaining)}`,
          );
      } catch (error) {
        inspectionErrors.push(
          `Owned PostgreSQL IPC cleanup could not be verified: ${String(error)}`,
        );
      }
    }
    return {
      ...outcome,
      timedOut,
      spawnError,
      ownedPids: [...identities.keys()],
      ownedProcessIdentities: [...identities].map(([pid, started]) => ({ pid, started })),
      signals,
      survivingOwnedPids: survivors.map((row) => row.pid),
      inspectionErrors,
      postgresCleanup,
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardDeadline);
    clearInterval(poll);
    await Promise.race([
      Promise.all(
        [child.stdout, child.stderr].map(
          (stream) =>
            new Promise<void>((resolve) => {
              if (!stream || stream.readableEnded || stream.destroyed) resolve();
              else stream.once("end", resolve);
            }),
        ),
      ),
      delay(500),
    ]);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.connected) child.disconnect();
    child.unref();
  }
}
