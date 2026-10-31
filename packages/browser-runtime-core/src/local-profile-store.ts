import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  FrozenProfileSeedSchema,
  HeldLocalProfileSchema,
  LocalProfileBindingSchema,
  type BrowserEngine,
  type FrozenProfileSeed,
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
import { ensurePrivateDirectory, syncDirectory } from "@opensteer/shared/privateFiles";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { BrowserRuntimeError } from "./errors.js";

const identitySchema = z.strictObject({ version: z.literal(1), storageInstanceId: z.uuid() });
const nativeSentinelSchema = z.strictObject({
  version: z.literal(1),
  binding: LocalProfileBindingSchema,
});
const markerSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["initializing", "ready"]),
  binding: LocalProfileBindingSchema,
  seed: FrozenProfileSeedSchema,
});
type Marker = z.infer<typeof markerSchema>;
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
export function sameFrozenSeed(left: FrozenProfileSeed, right: FrozenProfileSeed): boolean {
  return left.revision === right.revision && left.digest === right.digest;
}
function invalid(message = "The local browser profile storage is invalid."): BrowserRuntimeError {
  return new BrowserRuntimeError("conflict", message, { reason: "local-profile.storage-invalid" });
}

/** The one disk authority shared by Electron and Chromium; callers serialize each profile. */
export class LocalProfileStore {
  private readonly attempted = new Set<string>();
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
  private async marker(binding: LocalProfileBinding): Promise<Marker | undefined> {
    const profile = this.profile(binding);
    await realDirectoryIfPresent(path.join(this.root, "profiles"));
    await realDirectoryIfPresent(profile);
    const marker = await readJson(path.join(profile, "binding.v1.json"), markerSchema);
    if (marker && !sameLocalBinding(marker.binding, binding))
      throw invalid("The local browser profile binding does not match.");
    return marker;
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
  async hasProfile(profileId: string): Promise<boolean> {
    // Legacy tickets must never reopen a disposable copy of native state, including
    // corrupt/incomplete native state or a deletion restored out of the Host DB.
    if (!/^bpr_[a-f0-9-]+$/iu.test(profileId)) throw invalid();
    return (
      (await realDirectoryIfPresent(path.join(this.root, "profiles", profileId))) ||
      (await readJson(
        path.join(this.root, "tombstones", `${profileId}.json`),
        HeldLocalProfileSchema,
      )) !== undefined
    );
  }
  async inspect(
    binding: LocalProfileBinding,
    seed?: FrozenProfileSeed,
  ): Promise<Marker | undefined> {
    await this.assertNotDeleted(binding);
    const marker = await this.marker(binding);
    if (marker && seed && !sameFrozenSeed(marker.seed, seed))
      throw invalid("The frozen browser profile seed does not match.");
    return marker;
  }
  async requireReady(binding: LocalProfileBinding): Promise<string> {
    const marker = await this.inspect(binding);
    if (marker?.phase !== "ready")
      throw invalid("The native browser profile is missing or has not finished initialization.");
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
    return directory;
  }
  async initialize(binding: LocalProfileBinding, seed: FrozenProfileSeed): Promise<string> {
    FrozenProfileSeedSchema.parse(seed);
    const marker = await this.inspect(binding, seed);
    if (marker?.phase === "ready")
      throw invalid("A ready native browser profile must never be reimported.");
    if (this.attempted.has(binding.profileId) || retainedDirectories.has(this.directory(binding)))
      throw invalid("Profile initialization is fenced until this process exits.");
    const profile = this.profile(binding);
    await ensurePrivateDirectory(path.join(this.root, "profiles"));
    await ensurePrivateDirectory(profile);
    if (!marker && (await readdir(profile)).length)
      throw invalid("The browser profile marker is missing over existing data.");
    this.attempted.add(binding.profileId);
    if (marker) await rm(this.directory(binding), { force: true, recursive: true });
    await replacePrivateFileAtomically(
      path.join(profile, "binding.v1.json"),
      JSON.stringify({ version: 1, phase: "initializing", binding, seed }),
    );
    await mkdir(this.directory(binding), { mode: 0o700 });
    await syncDirectory(profile);
    return this.directory(binding);
  }
  async ready(binding: LocalProfileBinding, seed: FrozenProfileSeed): Promise<void> {
    const marker = await this.inspect(binding, seed);
    if (!marker) throw invalid();
    if (!(await realDirectoryIfPresent(this.directory(binding)))) throw invalid();
    if (marker.phase === "ready") {
      await this.requireReady(binding);
      return;
    }
    // Publish inside the engine's store before promoting its parent marker.
    // Missing sentinels on this unreleased format are damage, never a migration.
    await replacePrivateFileAtomically(
      path.join(this.directory(binding), "opensteer.v1.json"),
      JSON.stringify({ version: 1, binding }),
    );
    await replacePrivateFileAtomically(
      path.join(this.profile(binding), "binding.v1.json"),
      JSON.stringify({ ...marker, phase: "ready" }),
    );
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
    await this.marker(binding);
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
      const marker = await readJson(path.join(directory, "binding.v1.json"), markerSchema);
      // A crash before marker creation can leave an empty directory; it is not a claim.
      if (!marker) {
        if (
          (await readdir(directory)).some(
            (name) => !profileSidecar(privateFileTemporaryTarget(name) ?? ""),
          )
        )
          throw invalid();
        continue;
      }
      this.validate(marker.binding);
      if (marker.binding.profileId !== name) throw invalid();
      if (marker.phase === "ready") await this.requireReady(marker.binding);
      claims.set(name, { phase: marker.phase, binding: marker.binding, seed: marker.seed });
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
