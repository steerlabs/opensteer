import { lock } from "proper-lockfile";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pluginSnapshotDigest, readPluginSnapshot } from "@opensteer/agent-plugins";
import type { HarnessSkill } from "@opensteer/harness";
import type { RunPluginsPlan } from "@opensteer/protocol";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { z } from "zod";

const snapshotSchema = z
  .array(
    z.strictObject({
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (v) =>
            !v.includes("\\") &&
            !v.includes("\0") &&
            v.split("/").every((p) => p && p !== "." && p !== ".."),
        ),
      mode: z.number().int().min(0).max(0o777),
      content: z
        .string()
        .max(24 * 1024 * 1024)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
    }),
  )
  .max(10_000);
const pending = new Map<string, Promise<string>>();
const retentionMs = 30 * 24 * 60 * 60 * 1000;

export interface CachedRunPlugins {
  readonly cleanup: () => Promise<void>;
  readonly digest: string;
  readonly directory: string | undefined;
  readonly skills: readonly HarnessSkill[];
}

export async function fetchPluginPackage(input: {
  readonly stateDirectory: string;
  readonly digest: string;
  readonly fetchSnapshot: () => Promise<unknown>;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(input.digest)) throw new Error("Invalid plugin digest");
  const root = join(input.stateDirectory, "plugins", input.digest);
  let operation = pending.get(root);
  if (!operation) {
    operation = (async () => {
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid cached package");
        return root;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const files = snapshotSchema
        .parse(await input.fetchSnapshot())
        .map(({ path, mode, content }) => ({ path, mode, bytes: Buffer.from(content, "base64") }));
      if (
        files.reduce((n, f) => n + f.bytes.length, 0) > 64 * 1024 * 1024 ||
        files.some((f) => f.bytes.length > 16 * 1024 * 1024) ||
        pluginSnapshotDigest(files) !== input.digest
      )
        throw new Error("Plugin package digest mismatch or size limit exceeded");
      await mkdir(dirname(root), { recursive: true, mode: 0o700 });
      const stage = join(dirname(root), `.stage-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      try {
        for (const file of files) {
          const target = join(stage, file.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.bytes, { flag: "wx", mode: file.mode });
          await setFileMode(target, file.mode);
        }
        // Re-read with the install loader's limits and ordering before publishing.
        if (pluginSnapshotDigest(await readPluginSnapshot(stage)) !== input.digest)
          throw new Error("Plugin package digest mismatch");
        try {
          await rename(stage, root);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code)))
            throw error;
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      return root;
    })();
    pending.set(root, operation);
    void operation.finally(() => pending.delete(root)).catch(() => undefined);
  }
  const result = await operation;
  const now = new Date();
  await utimes(root, now, now);
  return result;
}

async function cacheLock(stateDirectory: string) {
  const root = join(stateDirectory, "plugins");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return lock(root, { realpath: false, retries: { retries: 50, minTimeout: 10, maxTimeout: 100 } });
}

export async function retainPluginPackages(
  stateDirectory: string,
  digests: readonly string[],
): Promise<() => Promise<void>> {
  const unlock = await cacheLock(stateDirectory);
  const leases: string[] = [];
  try {
    for (const digest of new Set(digests)) {
      if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid plugin digest");
      const directory = join(stateDirectory, "plugin-cache-references", digest);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lease = join(directory, `${process.pid}-${randomUUID()}`);
      await writeFile(lease, "", { flag: "wx", mode: 0o600 });
      leases.push(lease);
    }
  } finally {
    await unlock();
  }
  let released = false;
  return async () => {
    if (released) return;
    const unlock = await cacheLock(stateDirectory);
    try {
      for (const digest of digests) {
        const now = new Date();
        await utimes(join(stateDirectory, "plugins", digest), now, now).catch(() => undefined);
      }
      for (const lease of leases) await rm(lease, { force: true });
      released = true;
    } finally {
      await unlock();
    }
  };
}

async function hasProcessReference(stateDirectory: string, digest: string): Promise<boolean> {
  const directory = join(stateDirectory, "plugin-cache-references", digest);
  const leases = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let active = false;
  for (const lease of leases) {
    const pid = Number(lease.split("-")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      active = true;
      continue;
    }
    try {
      process.kill(pid, 0);
      active = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        await rm(join(directory, lease), { force: true });
      else active = true;
    }
  }
  return active;
}

export async function prunePluginCache(stateDirectory: string, now = Date.now()): Promise<void> {
  const unlock = await cacheLock(stateDirectory);
  try {
    await pruneUnreferenced(stateDirectory, now);
  } finally {
    await unlock();
  }
}

async function pruneUnreferenced(stateDirectory: string, now: number): Promise<void> {
  const root = join(stateDirectory, "plugins");
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/u.test(entry.name) || !entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (
      pending.has(path) ||
      now - stat.mtimeMs < retentionMs ||
      (await hasProcessReference(stateDirectory, entry.name))
    )
      continue;
    await rm(path, { recursive: true, force: true });
  }
}

export async function cacheRunPlugins(input: {
  readonly plan: RunPluginsPlan;
  readonly stateDirectory: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
}): Promise<CachedRunPlugins> {
  const cleanup = await retainPluginPackages(
    input.stateDirectory,
    input.plan.versions.map((v) => v.digest),
  );
  try {
    await prunePluginCache(input.stateDirectory);
    const skills: HarnessSkill[] = [];
    for (const version of input.plan.versions) {
      const root = await fetchPluginPackage({
        ...input,
        digest: version.digest,
        fetchSnapshot: async () => {
          const response = await fetch(`${input.plan.url}/${version.digest}`, {
            headers: { authorization: `Bearer ${input.plan.token}` },
            redirect: "error",
            signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
          });
          if (!response.ok) throw new Error(`Plugin package fetch failed: ${response.status}`);
          return JSON.parse(
            Buffer.from(
              await readBoundedResponse(response, {
                maximumBytes: 96 * 1024 * 1024,
                sizeError: () => new Error("Plugin package too large"),
              }),
            ).toString("utf8"),
          ) as unknown;
        },
      });
      for (const entry of await readdir(join(root, "skills"), { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      )) {
        if (
          entry.isDirectory() &&
          (await lstat(join(root, "skills", entry.name, "SKILL.md")).then(
            (s) => s.isFile(),
            () => false,
          ))
        )
          skills.push({
            plugin: version.name,
            localName: entry.name,
            fullName: `${version.name}:${entry.name}`,
            path: join(root, "skills", entry.name),
          });
      }
    }
    return {
      cleanup,
      digest: JSON.stringify(
        [...input.plan.versions].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
      ),
      directory: join(input.stateDirectory, "plugins"),
      skills,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
