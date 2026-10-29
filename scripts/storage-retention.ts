/** Owned storage only; --dry-run writes a receipt but never removes an artifact. */
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ensureStorageDirectory, reclaimVmStorage, type VmRetention } from "./test-vm/retention.js";

const execute = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const version = z.string().regex(/^\d+\.\d+\.\d+$/u);
const inventory = z.array(z.object({ Name: z.string(), State: z.string() }));

export async function retainHostStorage(options: {
  source: string;
  signal?: AbortSignal;
  dryRun?: boolean;
  log?: (line: string) => void;
  vm?: Pick<VmRetention, "vms" | "running" | "deleteVm">;
}): Promise<number> {
  const home = realpathSync(homedir());
  const state = path.join(home, ".local/state/opensteer");
  const cache = path.join(home, ".cache/opensteer/vm");
  ensureStorageDirectory(home, state);
  ensureStorageDirectory(home, cache);
  const log = options.log ?? console.log;
  const command = async (name: string, args: string[]) =>
    (
      await execute(name, args, {
        cwd: options.source,
        signal: options.signal,
        timeout: 20_000,
        maxBuffer: 4 * 1024 ** 2,
      })
    ).stdout.trim();
  const identify = async () => {
    let mainSha: string | undefined;
    let installedVersion: string | null | undefined;
    try {
      mainSha = sha.parse(
        await command("git", ["rev-parse", "--verify", "refs/remotes/origin/main"]),
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      log(`Cannot identify main payload; keeping payloads: ${String(error)}`);
    }
    // This is the only installed-version source. Never inspect or alter the app's files otherwise.
    const app = "/Applications/Opensteer Beta.app";
    const info = path.join(app, "Contents/Info.plist");
    try {
      if (lstatSync(app, { throwIfNoEntry: false }) === undefined) installedVersion = null;
      else {
        if (!lstatSync(info).isFile() || realpathSync(info) !== info)
          throw new Error("Info.plist is not canonical");
        installedVersion = version.parse(
          await command("/usr/libexec/PlistBuddy", [
            "-c",
            "Print :CFBundleShortVersionString",
            info,
          ]),
        );
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      log(`Cannot read installed Beta version; keeping release artifacts: ${String(error)}`);
    }
    return {
      mainSha,
      installedVersion,
      keepPayloads: Number(process.env.OPENSTEER_VM_PAYLOAD_KEEP ?? 4),
    };
  };
  return reclaimVmStorage({
    state,
    cache,
    tartVms: path.join(home, ".tart/vms"),
    now: Date.now(),
    ...(options.vm ?? {
      vms: async () =>
        inventory.parse(JSON.parse(await command("tart", ["list", "--format", "json"]))),
      running: async (name: string) => {
        try {
          await command("pgrep", ["-f", "--", name]);
          return true;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === 1) return false;
          throw error;
        }
      },
      deleteVm: async (name: string) => {
        await command("tart", ["delete", name]);
      },
    }),
    identify,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error("Storage retention interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await retainHostStorage({
      source: path.resolve(import.meta.dirname, ".."),
      signal: stop.signal,
      dryRun: values["dry-run"] ?? false,
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
