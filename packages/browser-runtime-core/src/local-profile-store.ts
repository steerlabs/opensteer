import {
  HeldLocalProfileSchema,
  LocalProfileBindingSchema,
  type BrowserEngine,
  type HeldLocalProfile,
  type LocalProfileBinding,
} from "@opensteer/protocol";
import {
  discardPrivateFileTemporaryFiles,
  privateFileTemporaryTarget,
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { ensurePrivateDirectory, syncDirectory } from "@opensteer/shared/privateFiles";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BrowserRuntimeError } from "./errors.js";

const identitySchema = z.strictObject({ version: z.literal(1), storageInstanceId: z.uuid() });
const nativeSentinelSchema = z.strictObject({
  version: z.literal(1),
  binding: LocalProfileBindingSchema,
});
type Tombstone = Extract<HeldLocalProfile, { phase: "deleted" }>;
// Root exclusivity across processes belongs to the caller. Logical runtimes may
// restart while Electron's path-keyed Sessions still own their native stores.
const activeRoots = new Set<string>();
const retainedDirectories = new Set<string>();

export function sameLocalBinding(left: LocalProfileBinding, right: LocalProfileBinding): boolean {
  return Object.keys(LocalProfileBindingSchema.shape).every(
    (key) => left[key as keyof LocalProfileBinding] === right[key as keyof LocalProfileBinding],
  );
}
function invalid(message = "The local browser profile storage is invalid."): BrowserRuntimeError {
  return new BrowserRuntimeError("conflict", message, { reason: "local-profile.storage-invalid" });
}

/** The one disk authority shared by Electron and Chromium; callers serialize each profile. */
export class LocalProfileStore {
  private readonly knownBindings = new Map<string, LocalProfileBinding>();
  private closed = false;
  readonly root: string;
  readonly storageInstanceId: string;
  readonly engine: BrowserEngine;
  private constructor(root: string, storageInstanceId: string, engine: BrowserEngine) {
    this.root = root;
    this.storageInstanceId = storageInstanceId;
    this.engine = engine;
  }

  static async acquire(root: string, engine: BrowserEngine): Promise<LocalProfileStore> {
    if (!path.isAbsolute(root) || path.resolve(root) !== root)
      throw new TypeError("localProfiles.root must be an absolute normalized path.");
    await securePrivateDirectory(root);
    const canonical = await realpath(root);
    if (activeRoots.has(canonical))
      throw invalid("This local browser profile storage is already in use.");
    activeRoots.add(canonical);
    try {
      await discardPrivateFileTemporaryFiles(canonical, (name) => name === "storage.v1.json");
      let identity = await readJson(path.join(canonical, "storage.v1.json"), identitySchema);
      if (!identity) {
        const entries = (await readdir(canonical)).filter(
          (entry) => entry !== ".owner.lock" && entry !== ".opensteer-runtime",
        );
        if (entries.length)
          throw invalid("The browser profile root identity is missing over existing data.");
        identity = { version: 1, storageInstanceId: randomUUID() };
        await replacePrivateFileAtomically(
          path.join(canonical, "storage.v1.json"),
          JSON.stringify(identity),
        );
      }
      const store = new LocalProfileStore(canonical, identity.storageInstanceId, engine);
      // Inventory may overlap live publications after acquire returns. Only
      // acquisition has exclusive access to every marker and tombstone writer.
      const tombstones = path.join(canonical, "tombstones");
      await realDirectoryIfPresent(tombstones);
      await discardPrivateFileTemporaryFiles(tombstones, tombstoneName);
      for (const name of await names(path.join(canonical, "profiles"))) {
        if (!/^bpr_[a-f0-9-]+$/iu.test(name)) throw invalid();
        const directory = path.join(canonical, "profiles", name);
        if (!(await realDirectoryIfPresent(directory))) throw invalid();
        await discardPrivateFileTemporaryFiles(directory, profileSidecar);
      }
      // A same-process re-acquire is not proof that Electron released its Session.
      // After process exit this registry is empty, so erasure precedes fromPath.
      for (const claim of await store.tombstones()) {
        if (!retainedDirectories.has(store.directory(claim.binding)))
          await store.erase(claim.binding, claim.deletionId);
      }
      return store;
    } catch (error) {
      activeRoots.delete(canonical);
      throw error;
    }
  }

  directory(binding: LocalProfileBinding): string {
    this.validate(binding);
    return path.join(this.root, "profiles", binding.profileId, "native");
  }
  private validate(binding: LocalProfileBinding): void {
    LocalProfileBindingSchema.parse(binding);
    if (
      this.closed ||
      binding.storageInstanceId !== this.storageInstanceId ||
      binding.engine !== this.engine
    )
      throw invalid("The browser profile belongs to a different storage instance or engine.");
  }
  private profile(binding: LocalProfileBinding): string {
    return path.dirname(this.directory(binding));
  }
  async assertNotDeleted(binding: LocalProfileBinding): Promise<void> {
    this.validate(binding);
    await realDirectoryIfPresent(path.join(this.root, "tombstones"));
    if (
      await readJson(
        path.join(this.root, "tombstones", `${binding.profileId}.json`),
        HeldLocalProfileSchema,
      )
    )
      throw invalid("This browser profile has been deleted.");
  }
  /** Publish only a never-created store, before an engine can own its final directory. */
  async provision(
    binding: LocalProfileBinding,
    initialized: boolean,
    createFiles: (profileDirectory: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    await this.assertNotDeleted(binding);
    const directory = this.directory(binding);
    if (await realDirectoryIfPresent(this.profile(binding))) return this.requireReady(binding);
    if (initialized)
      throw invalid(
        "The established native browser profile data is missing. Restore its original storage.",
      );
    await ensurePrivateDirectory(path.join(this.root, ".opensteer-runtime"));
    const staging = await mkdtemp(path.join(this.root, ".opensteer-runtime", "profile-"));
    try {
      await mkdir(path.join(staging, "native"), { mode: 0o700 });
      signal.throwIfAborted();
      await createFiles(staging);
      signal.throwIfAborted();
      await replacePrivateFileAtomically(
        path.join(staging, "native", "opensteer.v1.json"),
        JSON.stringify({ version: 1, binding }),
      );
      await ensurePrivateDirectory(path.join(this.root, "profiles"));
      await this.assertNotDeleted(binding);
      signal.throwIfAborted();
      // Root exclusivity and the profile lane exclude another publisher. No engine
      // has seen the staged path; an existing final store is never replaced.
      if (await realDirectoryIfPresent(this.profile(binding)))
        throw invalid("The native browser profile already exists.");
      signal.throwIfAborted();
      await rename(staging, this.profile(binding));
      await syncDirectory(path.join(this.root, "profiles"));
      return directory;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async requireReady(binding: LocalProfileBinding): Promise<string> {
    await this.assertNotDeleted(binding);
    const known = this.knownBindings.get(binding.profileId);
    if (known && !sameLocalBinding(known, binding))
      throw invalid("The native browser profile binding changed while this runtime owned it.");
    const directory = this.directory(binding);
    if (!(await realDirectoryIfPresent(directory)))
      throw invalid("The native browser profile data is missing.");
    const sentinel = await readJson(
      path.join(directory, "opensteer.v1.json"),
      nativeSentinelSchema,
    );
    if (!sentinel || !sameLocalBinding(sentinel.binding, binding))
      throw invalid(
        "The native browser profile storage sentinel is missing or does not match. The profile was preserved.",
      );
    this.knownBindings.set(binding.profileId, binding);
    return directory;
  }
  async tombstone(binding: LocalProfileBinding, deletionId: string): Promise<Tombstone> {
    this.validate(binding);
    const filename = path.join(this.root, "tombstones", `${binding.profileId}.json`);
    const existing = await readJson(filename, HeldLocalProfileSchema);
    if (existing) {
      if (
        existing.phase !== "deleted" ||
        !sameLocalBinding(existing.binding, binding) ||
        existing.deletionId !== deletionId
      )
        throw invalid();
      return existing;
    }
    const claim = HeldLocalProfileSchema.parse({
      phase: "deleted",
      binding,
      deletionId,
      erasure: "pending-restart",
    });
    if (claim.phase !== "deleted") throw invalid();
    await replacePrivateFileAtomically(filename, JSON.stringify(claim));
    return claim;
  }
  async erase(binding: LocalProfileBinding, deletionId: string): Promise<void> {
    if (retainedDirectories.has(this.directory(binding)))
      throw invalid("The browser profile directory is retained until this process exits.");
    await this.tombstone(binding, deletionId);
    await realDirectoryIfPresent(path.join(this.root, "profiles"));
    await rm(this.profile(binding), { force: true, recursive: true });
    if (await realDirectoryIfPresent(path.join(this.root, "profiles")))
      await syncDirectory(path.join(this.root, "profiles"));
    await replacePrivateFileAtomically(
      path.join(this.root, "tombstones", `${binding.profileId}.json`),
      JSON.stringify({ phase: "deleted", binding, deletionId, erasure: "deleted" }),
    );
  }
  async inventory(): Promise<HeldLocalProfile[]> {
    const claims = new Map<string, HeldLocalProfile>();
    for (const claim of await this.tombstones()) claims.set(claim.binding.profileId, claim);
    for (const name of await names(path.join(this.root, "profiles"))) {
      if (!/^bpr_[a-f0-9-]+$/iu.test(name)) throw invalid();
      if (claims.has(name)) continue;
      const directory = path.join(this.root, "profiles", name);
      if (!(await realDirectoryIfPresent(directory))) throw invalid();
      const sentinel = await readJson(
        path.join(directory, "native", "opensteer.v1.json"),
        nativeSentinelSchema,
      );
      if (!sentinel) throw invalid("The native browser profile sentinel is missing.");
      this.validate(sentinel.binding);
      if (sentinel.binding.profileId !== name) throw invalid();
      await this.requireReady(sentinel.binding);
      claims.set(name, { phase: "ready", binding: sentinel.binding });
    }
    return [...claims.values()];
  }
  private async tombstones(): Promise<Tombstone[]> {
    const claims: Tombstone[] = [];
    for (const name of await names(path.join(this.root, "tombstones"))) {
      if (tombstoneName(privateFileTemporaryTarget(name) ?? "")) continue;
      const claim = await readJson(
        path.join(this.root, "tombstones", name),
        HeldLocalProfileSchema,
      );
      if (!claim || claim.phase !== "deleted" || name !== `${claim.binding.profileId}.json`)
        throw invalid();
      this.validate(claim.binding);
      claims.push(claim);
    }
    return claims;
  }
  engineOwnsDirectory(binding: LocalProfileBinding): void {
    if (this.engine === "electron") this.retainDirectory(binding);
  }
  retainDirectory(binding: LocalProfileBinding): void {
    retainedDirectories.add(this.directory(binding));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    activeRoots.delete(this.root);
  }
}
async function readJson<T>(filename: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await readPrivateFileText(filename, 16 * 1024, { invalid, exposed: invalid });
  if (text === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw invalid();
  }
}
async function realDirectoryIfPresent(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}
async function names(directory: string): Promise<string[]> {
  return (await realDirectoryIfPresent(directory)) ? readdir(directory) : [];
}

function profileSidecar(name: string): boolean {
  return name === "binding.v1.json";
}

function tombstoneName(name: string): boolean {
  return /^bpr_[a-f0-9-]+\.json$/iu.test(name);
}
