/**
 * Reclaims the VM runner's own outputs: job clones, run directories and
 * payload caches and old release artifacts. VM/release preflights call it under
 * one exclusive storage lock; payload builders hold that same lock shared. Anything it cannot prove finished,
 * unused and unreferenced stays, and a candidate it cannot handle is logged
 * and kept.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statfsSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isNodeError } from "@opensteer/shared/nodeError";
import { tryKernelLock } from "@opensteer/shared/kernelLock";

const day = 86_400_000;
const runIdPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u;
const clonePattern = /^opensteer-(?:gui|mobile)-job-(\d{8}T\d{6}Z-[0-9a-f]{8})$/u;
const cachePattern = /^[0-9a-f]{40}$/u;
/** Notes, receipts and logs that name runs are small; larger files are not read. */
const referenceBytes = 4 * 1024 ** 2;
const jobSchema = z.object({
  startedAt: z.number(),
  endedAt: z.number().optional(),
  pid: z.number().int().positive().optional(),
  sha: z.string().optional(),
});
type JobRecord = z.infer<typeof jobSchema>;

export interface VmRetention {
  /** `~/.local/state/opensteer`: runs under `vm-runs/`, and the files that may reference them. */
  readonly state: string;
  /** `~/.cache/opensteer/vm`. */
  readonly cache: string;
  /** `~/.tart/vms`, read only to size a clone before Tart deletes it. */
  readonly tartVms: string;
  readonly now: number;
  readonly dryRun?: boolean;
  readonly storage?: {
    readonly mainSha: string | undefined;
    /** undefined means unreadable; null means Beta is not installed. */
    readonly installedVersion: string | null | undefined;
    readonly keepPayloads: number;
  };
  /** Resolve volatile identity only after storage admission, never before queueing. */
  readonly identify?: () => Promise<NonNullable<VmRetention["storage"]>>;
  readonly onCandidate?: (kind: string, target: string, bytes: number) => void;
  readonly vms: () => Promise<readonly { Name: string; State: string }[]>;
  /** Whether any process names the VM in its arguments, such as its `tart run`. */
  readonly running: (name: string) => Promise<boolean>;
  readonly deleteVm: (name: string) => Promise<void>;
  readonly log: (line: string) => void;
  /** Cancellation stops retention; other failures only keep the candidate. */
  readonly signal?: AbortSignal;
}

/** Returns allocated bytes removed, or eligible for removal in a dry run. */
export async function reclaimVmStorage(options: VmRetention): Promise<number> {
  const candidates: { kind: string; target: string; bytes: number }[] = [];
  const receipt = {
    startedAt: new Date().toISOString(),
    dryRun: options.dryRun ?? false,
    freeBytesBefore: 0,
    freeBytesAfter: 0,
    bytesFreed: 0,
    candidateBytes: 0,
    removedAllocatedBytes: 0,
    policy: undefined as VmRetention["storage"],
    candidates,
    removed: [] as typeof candidates,
    warnings: [] as string[],
    error: undefined as string | undefined,
  };
  // Canonical roots are checked before opening a lock or writing a receipt.
  canonical(options.state, options.state);
  canonical(options.cache, options.cache);
  const directory = path.join(options.state, "storage-retention");
  ensureStorageDirectory(options.state, directory);
  const filename = path.join(directory, `${Date.now()}-${randomUUID()}.json`);
  let descriptor: number | undefined;
  try {
    receipt.freeBytesBefore = free(options.state);
    descriptor = await holdStorageLock(options.state, "exclusive", options.signal);
    const storage = options.identify ? await options.identify() : options.storage;
    receipt.policy = storage;
    const bytes = await reclaimUnlocked({
      ...options,
      ...(storage ? { storage } : {}),
      log: (line) => {
        if (line.startsWith("kept")) receipt.warnings.push(line);
        options.log(line);
      },
      onCandidate: (kind, target, count) => {
        candidates.push({ kind, target, bytes: count });
        options.onCandidate?.(kind, target, count);
      },
    });
    receipt.candidateBytes = candidates.reduce((sum, row) => sum + row.bytes, 0);
    if (!options.dryRun) {
      receipt.bytesFreed = receipt.candidateBytes;
      receipt.removed = [...candidates];
    }
    return bytes;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      receipt.candidateBytes = candidates.reduce((sum, row) => sum + row.bytes, 0);
      receipt.removedAllocatedBytes = options.dryRun ? 0 : receipt.candidateBytes;
      receipt.removed = options.dryRun ? [] : [...candidates];
      receipt.freeBytesAfter = free(options.state);
      // Other shared jobs and APFS block sharing can change the observed delta.
      receipt.bytesFreed = options.dryRun
        ? 0
        : Math.max(0, receipt.freeBytesAfter - receipt.freeBytesBefore);
      const change = receipt.freeBytesAfter - receipt.freeBytesBefore;
      if (receipt.freeBytesAfter < 80 * 1024 ** 3) {
        const consumers = [
          options.cache,
          ...entries(options.state)
            .filter((name) => name.startsWith("release-") || name === "vm-runs")
            .map((name) => path.join(options.state, name)),
        ]
          .map((target) => ({ target, bytes: allocated(target) }))
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 5);
        const warning = `WARNING: free space ${size(receipt.freeBytesAfter)} is below 80 GiB; largest remaining consumers: ${consumers.map((row) => `${row.target} (${size(row.bytes)})`).join(", ")}`;
        receipt.warnings.push(warning);
        options.log(warning);
      }
      writeFileSync(filename, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      options.log(
        `${options.dryRun ? "would reclaim" : "removed"} ${size(receipt.candidateBytes)} allocated; free space ${size(receipt.freeBytesBefore)} -> ${size(receipt.freeBytesAfter)} (observed ${change < 0 ? "loss" : "gain"} ${size(Math.abs(change))})`,
      );
      options.log(`retention receipt: ${filename}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

/** Shared by all payload builders; retention takes this same inode exclusively. */
export async function holdStorageLock(
  state: string,
  mode: "shared" | "exclusive",
  signal?: AbortSignal,
): Promise<number> {
  if (process.platform !== "darwin")
    throw new Error("Storage retention requires Darwin kernel locking; no deletion attempted");
  canonical(state, state);
  const directory = path.join(state, "vm/locks");
  ensureStorageDirectory(state, directory);
  while (true) {
    signal?.throwIfAborted();
    const descriptor = tryKernelLock(path.join(directory, "storage-retention"), mode);
    if (descriptor !== undefined) return descriptor;
    try {
      await delay(25, undefined, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }
}

async function reclaimUnlocked(options: VmRetention): Promise<number> {
  let reclaimed = 0;
  const attempt = async (kind: string, target: string, remove: () => Promise<number | void>) => {
    options.signal?.throwIfAborted();
    try {
      const bytes = await remove();
      if (bytes === undefined) return true;
      reclaimed += bytes;
      options.onCandidate?.(kind, target, bytes);
      options.log(
        `${options.dryRun ? "would delete" : "deleted"} ${kind} ${target} (${size(bytes)})`,
      );
      return true;
    } catch (error) {
      options.signal?.throwIfAborted();
      options.log(
        `kept ${kind} ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  const runs = path.join(options.state, "vm-runs");
  const jobs = new Map<string, JobRecord | undefined>();
  for (const runId of entries(runs).filter((name) => runIdPattern.test(name)))
    if (lstatSync(path.join(runs, runId)).isDirectory()) jobs.set(runId, readJob(runs, runId));

  // A clone's job record is its owner, so clones go before runs.
  const clones = new Set<string>();
  let inventory: readonly { Name: string; State: string }[];
  let inventoryKnown = true;
  try {
    inventory = await options.vms();
  } catch (error) {
    options.log(`kept runs and clones: inventory unavailable (${String(error)})`);
    inventory = [];
    inventoryKnown = false;
    for (const runId of jobs.keys()) clones.add(runId);
  }
  for (const vm of inventory) {
    const runId = clonePattern.exec(vm.Name)?.[1];
    if (!runId) continue;
    const record = jobs.get(runId);
    const removable =
      record &&
      finished(record) &&
      vm.State === "stopped" &&
      !(await options.running(vm.Name)) &&
      (await attempt("clone", vm.Name, async () => {
        canonical(options.tartVms, path.join(options.tartVms, vm.Name));
        const bytes = allocated(path.join(options.tartVms, vm.Name));
        if (!options.dryRun) await options.deleteVm(vm.Name);
        return bytes;
      }));
    if (!removable) clones.add(runId);
  }

  // Only a recorded end or a dead runner proves a job finished; its age counts from then.
  const old = [...jobs].filter(
    ([runId, record]) =>
      record &&
      !clones.has(runId) &&
      finished(record) &&
      options.now - (record.endedAt ?? record.startedAt) * 1000 >= day,
  );
  const references: ReturnType<typeof referencedRunIds> = old.length
    ? referencedRunIds(options.state)
    : { runIds: new Set() };
  if (references.unreadable)
    options.log(`kept every old run: cannot read ${references.unreadable}`);
  else
    for (const [runId] of old) {
      if (references.runIds.has(runId)) continue;
      const target = path.join(runs, runId);
      await attempt("run", target, async () => {
        canonical(options.state, target);
        assertTree(options.state, target);
        const bytes = allocated(target);
        if (!options.dryRun) rmSync(target, { recursive: true });
        jobs.delete(runId);
        return bytes;
      });
    }

  const unfinished = new Set(
    [...jobs.values()].filter((record) => record && !finished(record)).map((record) => record?.sha),
  );
  const releases = releaseDirectories(options.state);
  const versions = [...new Set(releases.map((row) => row.version))].sort(compareVersions);
  // An unfinished/newer version directory must not evict a completed release.
  const completed = [
    ...new Set(releases.filter((row) => completedRelease(row.target)).map((row) => row.version)),
  ].sort(compareVersions);
  const identitiesByDirectory = new Map(
    releases.map((row) => [row.target, releaseIdentities(row.target, row.version)]),
  );
  const identifiedVersions = versions.filter((version) =>
    releases.some((row) => row.version === version && identitiesByDirectory.get(row.target)),
  );
  const lastTwo = new Set([...identifiedVersions.slice(0, 2), ...completed.slice(0, 2)]);
  const pinned = new Set<string>();
  for (const release of releases) {
    const identities = identitiesByDirectory.get(release.target);
    if (identities && lastTwo.has(release.version))
      for (const identity of identities) pinned.add(identity);
    else if (!identities) {
      // A future gate-only scaffold is not a release. Unknown source records
      // retain their own SHA candidates, not every unrelated payload cache.
      for (const name of entries(release.target).filter((value) => cachePattern.test(value)))
        pinned.add(name);
    }
  }
  const policy = options.storage;
  const unknownActiveVm = inventory.some((vm) => {
    const runId = clonePattern.exec(vm.Name)?.[1];
    return vm.State !== "stopped" && runId !== undefined && !jobs.get(runId)?.sha;
  });
  if (
    inventoryKnown &&
    !unknownActiveVm &&
    policy?.mainSha &&
    cachePattern.test(policy.mainSha) &&
    Number.isSafeInteger(policy.keepPayloads) &&
    policy.keepPayloads >= 0
  ) {
    pinned.add(policy.mainSha);
    const caches = entries(options.cache)
      .filter((name) => cachePattern.test(name))
      .map((sha) => ({ sha, used: lastUsed(path.join(options.cache, sha)) }));
    const newest = caches
      .filter((entry) => entry.used !== undefined)
      .sort((a, b) => b.used! - a.used! || b.sha.localeCompare(a.sha))
      .slice(0, policy.keepPayloads);
    for (const entry of newest) pinned.add(entry.sha);
    for (const { sha } of caches) {
      if (pinned.has(sha) || unfinished.has(sha)) continue;
      const entry = path.join(options.cache, sha);
      await attempt("cache", entry, async () => {
        const descriptor = tryKernelLock(`${entry}.lock`);
        if (descriptor === undefined) return;
        try {
          canonical(options.cache, entry);
          assertTree(options.cache, entry);
          // Re-read after taking the entry lock: a builder may have just used it.
          const used = lastUsed(entry);
          if (used === undefined || used > (newest.at(-1)?.used ?? options.now)) return;
          const bytes = allocated(entry);
          if (!options.dryRun) rmSync(entry, { recursive: true });
          return bytes;
        } finally {
          closeSync(descriptor);
        }
      });
    }
  } else
    options.log(
      "kept payloads: VM inventory, ownership, main/release identity or retention configuration unknown",
    );

  // Candidate artifacts use the same storage admission and SHA lock as their
  // phone builders. Unknown queue state keeps them; history pins are conservative.
  const candidateRoot = path.join(path.dirname(options.cache), "release-candidates");
  if (policy?.mainSha && cachePattern.test(policy.mainSha)) {
    const queued = new Set<string>();
    let queueKnown = true;
    try {
      for (const directory of ["candidates", "submissions"]) {
        const root = path.join(options.state, "merge-queue", directory);
        for (const name of entries(root)) {
          const filename = path.join(root, name);
          canonical(options.state, filename);
          const stats = lstatSync(filename);
          if (!stats.isFile() || stats.size > referenceBytes)
            throw new Error("unknown candidate queue record");
          for (const match of readFileSync(filename, "utf8").matchAll(/\b[a-f0-9]{40}\b/gu))
            queued.add(match[0]);
        }
      }
    } catch {
      queueKnown = false;
      options.log("kept candidate caches: queue records unknown");
    }
    if (queueKnown)
      for (const identity of entries(candidateRoot).filter((name) => cachePattern.test(name))) {
        if (pinned.has(identity) || unfinished.has(identity) || queued.has(identity)) continue;
        const entry = path.join(candidateRoot, identity);
        await attempt("candidate cache", entry, async () => {
          canonical(candidateRoot, candidateRoot);
          const rootOwner = lstatSync(candidateRoot);
          if (rootOwner.uid !== process.getuid?.() || (rootOwner.mode & 0o022) !== 0)
            throw new Error("candidate cache root owner/mode mismatch");
          const descriptor = tryKernelLock(`${entry}.lock`);
          if (descriptor === undefined) return;
          try {
            canonical(candidateRoot, entry);
            const files = assertTree(candidateRoot, entry);
            if ([entry, ...files].some((file) => lstatSync(file).uid !== process.getuid?.()))
              throw new Error("candidate cache owner mismatch");
            const bytes = allocated(entry);
            if (!options.dryRun) rmSync(entry, { recursive: true });
            return bytes;
          } finally {
            closeSync(descriptor);
          }
        });
      }
  } else options.log("kept candidate caches: main identity unknown");

  // Release folders come from the retired local release pipeline; releases now build on
  // GitHub Actions and the installed Beta updates itself. Only the installed version's
  // folder stays, and records that pipeline wrote no longer keep anything.
  if (policy?.installedVersion === undefined)
    options.log("kept release artifacts: installed Beta version unknown");
  else {
    for (const release of releases) {
      if (release.version === policy.installedVersion) continue;
      await attempt("release", release.target, async () => {
        canonical(options.state, release.target);
        const files = assertTree(options.state, release.target);
        const identities = releaseIdentities(release.target, release.version);
        if (!identities) throw new Error("release identity unknown");
        const coordinators: number[] = [];
        try {
          for (const identity of identities) {
            const descriptor = tryKernelLock(
              path.join(release.target, identity, "coordinator.lock"),
            );
            if (descriptor === undefined) throw new Error("a release is in progress");
            coordinators.push(descriptor);
          }
          for (const filename of files) {
            const relative = path.relative(release.target, filename);
            // Crash diagnostics cannot be recreated from a later build.
            // Keep whole dSYMs, R8 records (including partition maps), and
            // source/native symbol sidecars independently of size or age.
            if (
              /(?:^|\/)[^/]+\.dSYM(?:\.(?:zip|tar(?:\.gz)?))?(?:\/|$)/iu.test(relative) ||
              /(?:^|\/)(?:mapping\.(?:txt|prt)|seeds\.txt|usage\.txt)$/iu.test(relative) ||
              /(?:^|\/)outputs\/mapping\/.*\.(?:txt|prt)$/iu.test(relative) ||
              /\.(?:map|bcsymbolmap|pdb|debug|dwo|dwp|sym)$/iu.test(relative) ||
              /(?:^|\/)native-debug-symbols\.zip$/iu.test(relative)
            )
              continue;
            const stats = lstatSync(filename);
            // Large build outputs only. Logs, unknown files and all small records stay.
            if (stats.size < 1024 ** 2 || /\.(?:log|jsonl)$/iu.test(filename)) continue;
            // A release checkout is not wholly a build product. Keep source
            // files; only generated subtrees are disposable there.
            if (
              /(?:^|\/)source\//u.test(relative) &&
              !/(?:^|\/)(?:node_modules|dist|build|\.next|\.electron-smoke|\.release|coverage)\//u.test(
                relative,
              )
            )
              continue;
            if (
              !/\.(?:tar|tgz|gz|xz|zst|zip|dmg|pkg|apk|aab|asar|dylib|so|node|wasm|bin)$/iu.test(
                filename,
              ) &&
              !/(?:^|\/)(?:source|mac|mac-state|phone|agent-phone|infra)\//u.test(relative)
            )
              continue;
            canonical(options.state, filename);
            const count = stats.nlink === 1 ? stats.blocks * 512 : 0;
            if (!options.dryRun) rmSync(filename);
            reclaimed += count;
            options.onCandidate?.("release artifact", filename, count);
            options.log(
              `${options.dryRun ? "would delete" : "deleted"} release artifact ${filename} (${size(count)})`,
            );
          }
        } finally {
          for (const descriptor of coordinators) closeSync(descriptor);
        }
        // Individual files are the receipt entries; don't double-count the directory.
      });
    }
  }
  return reclaimed;
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function entries(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function readJob(runs: string, runId: string): JobRecord | undefined {
  try {
    canonical(runs, path.join(runs, runId, "job.json"));
    return z
      .object({ runId: z.literal(runId) })
      .and(jobSchema)
      .parse(JSON.parse(readFileSync(path.join(runs, runId, "job.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/** Its runner recorded the end, or the runner is gone; a reused pid only keeps it longer. */
function finished(record: JobRecord): boolean {
  if (record.endedAt !== undefined) return true;
  if (record.pid === undefined) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

function lastUsed(entry: string): number | undefined {
  try {
    canonical(entry, path.join(entry, "last-used"));
    const stats = lstatSync(path.join(entry, "last-used"));
    if (!stats.isFile()) return undefined;
    return stats.mtimeMs;
  } catch {
    // Entries from before stamps count from their build.
    try {
      canonical(entry, path.join(entry, "payload.json"));
      const { builtAt } = z
        .object({ builtAt: z.number() })
        .parse(JSON.parse(readFileSync(path.join(entry, "payload.json"), "utf8")));
      return builtAt * 1000;
    } catch {
      return undefined;
    }
  }
}

/** `YYYYMMDDTHHMMSSZ-xxxxxxxx`: every run ID has this length. */
const runIdLength = 25;

/**
 * Adds every run ID in `bytes[0, end)`. Each "Z-" is checked in place, so an ID
 * that starts inside another's hex suffix still counts (missing one would delete
 * a referenced run). A regex over decoded text cost minutes of CPU per admission.
 */
export function addRunIds(bytes: Buffer, end: number, into: Set<string>): void {
  const view = bytes.subarray(0, end);
  for (
    let at = view.indexOf("Z-", 15, "latin1");
    at !== -1;
    at = view.indexOf("Z-", at + 1, "latin1")
  ) {
    const start = at - 15;
    if (start + runIdLength > end) return;
    if (isRunIdAt(view, start)) into.add(view.toString("latin1", start, start + runIdLength));
  }
}

/**
 * Adds the run IDs in successive reads through `buffer`. The last bytes of each read lead
 * the next, so an ID split across two reads is whole.
 */
export function addRunIdsFromReads(
  read: (into: Buffer, offset: number, length: number) => number,
  buffer: Buffer,
  into: Set<string>,
): void {
  let carried = 0;
  while (true) {
    const count = read(buffer, carried, buffer.length - carried);
    if (!count) return;
    const end = carried + count;
    addRunIds(buffer, end, into);
    carried = Math.min(runIdLength - 1, end);
    buffer.copy(buffer, 0, end - carried, end);
  }
}

function isRunIdAt(bytes: Buffer, start: number): boolean {
  for (let offset = 0; offset < 15; offset += 1) {
    const byte = bytes[start + offset]!;
    if (offset === 8 ? byte !== 0x54 : byte < 0x30 || byte > 0x39) return false;
  }
  for (let offset = 17; offset < runIdLength; offset += 1) {
    const byte = bytes[start + offset]!;
    if ((byte < 0x30 || byte > 0x39) && (byte < 0x61 || byte > 0x66)) return false;
  }
  return true;
}

/**
 * Run IDs named by any file in the state tree that may name a run: notes,
 * receipts, release state and logs up to `referenceBytes`, larger text records,
 * a symlink's target file and the link itself. Not read: the runner's own
 * outputs, checkouts (anything holding `.git`), dependencies, app bundles and
 * Xcode build products. Only the IDs are kept; a busy host holds tens of GiB of
 * such files, far more than admission can hold in memory.
 */
export function referencedRunIds(state: string): { runIds: Set<string>; unreadable?: string } {
  const runIds = new Set<string>();
  const pending = [state];
  const skipped = new Set([
    "vm-runs",
    "vm",
    "locks",
    "worktrees",
    "vm-golden",
    "storage-retention",
    // Logs under sweep/ name every VM job they ran; a receipt there keeps copies
    // of the small files it validated, so those jobs' large output can go.
    "sweep",
  ]);
  // One read buffer for the whole scan: hundreds of thousands of mostly tiny files.
  const buffer = Buffer.allocUnsafe(1024 ** 2);
  const read = (filename: string) => {
    const stats = statSync(filename);
    if (
      !stats.isFile() ||
      (stats.size > referenceBytes && !/\.(?:json|jsonl|md|txt|log)$/iu.test(filename))
    )
      return;
    const descriptor = openSync(filename, "r");
    try {
      addRunIdsFromReads(
        (into, offset, length) => readSync(descriptor, into, offset, length, null),
        buffer,
        runIds,
      );
    } finally {
      closeSync(descriptor);
    }
  };
  while (pending.length) {
    const directory = pending.pop()!;
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      return { runIds, unreadable: directory };
    }
    if (directory !== state && children.some((child) => child.name === ".git")) continue;
    for (const child of children) {
      const filename = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (directory === state && skipped.has(child.name)) continue;
        if (["node_modules", "DerivedData"].includes(child.name) || child.name.endsWith(".app"))
          continue;
        pending.push(filename);
        continue;
      }
      try {
        if (child.isSymbolicLink()) {
          const link = readlinkSync(filename, { encoding: "buffer" });
          addRunIds(link, link.length, runIds);
          try {
            read(filename);
          } catch (error) {
            // A dangling or looping link has no target to read; its own text counts.
            if (!isNodeError(error) || !["ENOENT", "ELOOP"].includes(error.code ?? "")) throw error;
          }
        } else if (child.isFile()) read(filename);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        return { runIds, unreadable: filename };
      }
    }
  }
  return { runIds };
}

/** Allocated bytes, like du(1): sparse disks count only what they use. */
function allocated(target: string): number {
  let bytes = 0;
  const pending = [target];
  while (pending.length) {
    const filename = pending.pop()!;
    let stats;
    try {
      stats = lstatSync(filename);
    } catch {
      continue;
    }
    if (stats.nlink === 1 || stats.isDirectory()) bytes += stats.blocks * 512;
    if (stats.isDirectory())
      for (const name of entries(filename)) pending.push(path.join(filename, name));
  }
  return bytes;
}

function free(directory: string): number {
  const disk = statfsSync(directory);
  return disk.bavail * disk.bsize;
}

function canonical(root: string, target: string): void {
  const base = path.resolve(root);
  const filename = path.resolve(target);
  if (
    realpathSync(base) !== base ||
    (filename !== base && !filename.startsWith(base + path.sep)) ||
    realpathSync(filename) !== filename
  )
    throw new Error(`non-canonical path or symlink escape: ${target}`);
}

export function ensureStorageDirectory(root: string, directory: string): void {
  canonical(root, root);
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep)) {
    if (!component || component === "..") throw new Error("Directory escapes owned root");
    current = path.join(current, component);
    try {
      mkdirSync(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    canonical(root, current);
  }
}

/** Never follow a link while planning or deleting; an escaping link refuses the candidate. */
function assertTree(root: string, target: string): string[] {
  canonical(root, target);
  const files: string[] = [];
  const pending = [target];
  while (pending.length) {
    const filename = pending.pop()!;
    const stats = lstatSync(filename);
    if (stats.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = realpathSync(filename);
      } catch {
        throw new Error(`unknown symlink target: ${filename}`);
      }
      if (!resolved.startsWith(path.resolve(root) + path.sep))
        throw new Error(`symlink escape: ${filename}`);
    } else if (stats.isDirectory()) {
      for (const name of entries(filename)) pending.push(path.join(filename, name));
    } else if (stats.isFile()) files.push(filename);
    else throw new Error(`unknown file type: ${filename}`);
  }
  return files;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i]! - left[i]!;
  return 0;
}

function releaseDirectories(state: string): { version: string; target: string }[] {
  return entries(state).flatMap((name) => {
    const version = /^release-(\d+\.\d+\.\d+)(?:-|$)/u.exec(name)?.[1];
    const target = path.join(state, name);
    return version && lstatSync(target).isDirectory() ? [{ version, target }] : [];
  });
}

function releaseIdentities(directory: string, version: string): string[] | undefined {
  try {
    canonical(directory, directory);
    const identities: string[] = [];
    for (const name of entries(directory).filter((value) => cachePattern.test(value))) {
      const filename = path.join(directory, name, "release.json");
      canonical(directory, filename);
      const record = z
        .object({
          identity: z.object({ version: z.literal(version), sourceRevision: z.literal(name) }),
        })
        .parse(JSON.parse(readFileSync(filename, "utf8")));
      identities.push(record.identity.sourceRevision);
    }
    return identities.length ? identities : undefined;
  } catch {
    return undefined;
  }
}

function completedRelease(directory: string): boolean {
  try {
    return entries(directory)
      .filter((name) => cachePattern.test(name))
      .some((name) => {
        const filename = path.join(directory, name, "release.json");
        canonical(directory, filename);
        const record = z
          .object({ events: z.array(z.object({ phase: z.string(), status: z.string() })) })
          .parse(JSON.parse(readFileSync(filename, "utf8")));
        return record.events.some(
          (event) => event.phase === "verifyLive" && event.status === "complete",
        );
      });
  } catch {
    return false;
  }
}
