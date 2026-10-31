import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
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
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import {
  ensurePrivateDirectory,
  noFollowFlag,
  syncDirectory,
} from "@opensteer/shared/privateFiles";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { BrowserRuntimeError } from "./errors.js";

const identitySchema = z.strictObject({ version: z.literal(1), storageInstanceId: z.uuid() });
const markerSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["initializing", "ready"]),
  binding: LocalProfileBindingSchema,
  seed: FrozenProfileSeedSchema,
});
type Marker = z.infer<typeof markerSchema>;
type Tombstone = Extract<HeldLocalProfile, { phase: "deleted" }>;
// Electron owns fromPath Sessions beyond logical runtime shutdown. Keep the descriptor
// reachable until process exit, even when the runtime itself is collected.
const retainedLocks = new Set<LocalProfileStore>();

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
  private retained = false;
  private closed = false;
  readonly root: string;
  readonly storageInstanceId: string;
  readonly engine: BrowserEngine;
  private readonly descriptor: number;
  private constructor(
    root: string,
    storageInstanceId: string,
    engine: BrowserEngine,
    descriptor: number,
  ) {
    this.root = root;
    this.storageInstanceId = storageInstanceId;
    this.engine = engine;
    this.descriptor = descriptor;
  }

  static async acquire(root: string, engine: BrowserEngine): Promise<LocalProfileStore> {
    if (!path.isAbsolute(root) || path.resolve(root) !== root)
      throw new TypeError("localProfiles.root must be an absolute normalized path.");
    await securePrivateDirectory(root);
    const canonical = await realpath(root);
    const descriptor = openSync(
      path.join(canonical, ".owner.lock"),
      constants.O_CREAT | constants.O_RDWR | noFollowFlag(),
      0o600,
    );
    try {
      // Native addon resolution must stay relative to the installed app after bundling.
      const { tryLock } = createRequire(import.meta.url)("fs-native-extensions") as {
        tryLock(descriptor: number): boolean;
      };
      if (!tryLock(descriptor))
        throw invalid("This local browser profile storage is already in use.");
      let identity = await readJson(path.join(canonical, "storage.v1.json"), identitySchema);
      if (!identity) {
        const entries = (await readdir(canonical)).filter((entry) => entry !== ".owner.lock");
        if (entries.length)
          throw invalid("The browser profile root identity is missing over existing data.");
        identity = { version: 1, storageInstanceId: randomUUID() };
        await replacePrivateFileAtomically(
          path.join(canonical, "storage.v1.json"),
          JSON.stringify(identity),
        );
      }
      const store = new LocalProfileStore(
        canonical,
        identity.storageInstanceId,
        engine,
        descriptor,
      );
      // A new exclusive owner is proof that the previous process has released all
      // browser-writing ownership. Erase tombstoned trees before engine creation.
      for (const claim of await store.tombstones()) {
        if (claim.phase === "deleted") await store.erase(claim.binding, claim.deletionId);
      }
      return store;
    } catch (error) {
      closeSync(descriptor);
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
    return directory;
  }
  async initialize(binding: LocalProfileBinding, seed: FrozenProfileSeed): Promise<string> {
    FrozenProfileSeedSchema.parse(seed);
    const marker = await this.inspect(binding, seed);
    if (marker?.phase === "ready")
      throw invalid("A ready native browser profile must never be reimported.");
    if (this.attempted.has(binding.profileId))
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
    if (marker.phase === "ready") return;
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
        if ((await readdir(directory)).length) throw invalid();
        continue;
      }
      this.validate(marker.binding);
      if (marker.binding.profileId !== name) throw invalid();
      if (
        marker.phase === "ready" &&
        !(await realDirectoryIfPresent(this.directory(marker.binding)))
      )
        throw invalid("The native browser profile data is missing.");
      claims.set(name, { phase: marker.phase, binding: marker.binding, seed: marker.seed });
    }
    return [...claims.values()];
  }
  private async tombstones(): Promise<Tombstone[]> {
    const claims: Tombstone[] = [];
    for (const name of await names(path.join(this.root, "tombstones"))) {
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
  engineOwnsDirectory(): void {
    if (this.engine === "electron") {
      this.retained = true;
      retainedLocks.add(this);
    }
  }
  async close(): Promise<void> {
    if (this.closed || this.retained) return;
    this.closed = true;
    closeSync(this.descriptor);
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
