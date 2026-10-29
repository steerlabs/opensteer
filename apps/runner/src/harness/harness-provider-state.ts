import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  HarnessInstanceDefinition,
  HarnessProviderState,
  HarnessProviderStore,
  HarnessProviderStoreScope,
  HarnessRuntimeBoundary,
} from "@opensteer/harness";

export interface HarnessProviderStateOptions {
  /** The harness process environment, which may relocate an ambient provider home. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * The Runner's data directory, reported to drivers as the root that
   * model-executed tools must never read. The harness-state layout below lives
   * inside it, and so do the Runner's own keys and mount credentials.
   */
  readonly privateStateRoot: string;
  readonly runtimeBoundary: HarnessRuntimeBoundary;
  /** Where profiles and stores are laid out; a subdirectory of `privateStateRoot`. */
  readonly stateDirectory: string;
  readonly storeScope: HarnessProviderStoreScope;
}

export interface PreparedHarnessProviderState {
  readonly providerState: HarnessProviderState;
  /**
   * Continuation keys this store answered under before. They exist only so the
   * Host can move Threads that were pinned to a per-profile identity onto the
   * store identity that replaced it; nothing resumes through them.
   */
  readonly supersededContinuationKeys: readonly string[];
}

/**
 * Resolves one profile's private storage without using filesystem paths as
 * identity.
 *
 * Credentials belong to the profile and the native session store belongs to the
 * execution environment, so a profile's provider home is never the continuation
 * identity: the store is. That is what lets two profiles signed into different
 * accounts continue the same provider conversation, and it is why a re-login
 * behind one profile no longer fences a Thread off from its own history.
 */
export async function prepareHarnessProviderState(
  definition: HarnessInstanceDefinition,
  options: HarnessProviderStateOptions,
): Promise<PreparedHarnessProviderState> {
  if (definition.stateKind === "ambient" && options.runtimeBoundary.kind !== "native-user") {
    throw new Error("Ambient harness profiles require a native-user Runner");
  }
  const root = resolve(options.stateDirectory);
  const directory = profileDirectory(root, definition.id);
  const providerHomeDirectory =
    definition.stateKind === "isolated" ? join(directory, "provider-home") : undefined;

  await mkdir(directory, { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(directory);
  if (providerHomeDirectory) {
    await mkdir(providerHomeDirectory, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(providerHomeDirectory);
  }

  const layout = storeLayout(definition, root, providerHomeDirectory, options);
  await mkdir(layout.metadataDirectory, { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(layout.metadataDirectory);
  const legacyKey = await readLegacyContinuationKey(definition, directory);
  const metadata = await withStoreMetadataLock(layout.metadataDirectory, async () => {
    const current = await readOrCreateStoreMetadata(layout.metadataDirectory);
    if (!legacyKey || current.supersededKeys.includes(legacyKey)) return current;
    if (current.supersededKeys.length >= maxSupersededKeys) {
      throw new Error("Harness store metadata cannot adopt any more legacy profiles");
    }
    const next: HarnessStoreMetadata = {
      id: current.id,
      supersededKeys: [...current.supersededKeys, legacyKey],
    };
    await writeStoreMetadata(layout.metadataDirectory, next);
    return next;
  });
  // Only after the store durably owns the old key can the profile record go: a
  // crash in between must re-run the adoption rather than lose the Threads
  // pinned to it.
  if (legacyKey && metadata.supersededKeys.includes(legacyKey)) {
    await rm(legacyMetadataPath(directory), { force: true });
  }

  // A store the Runner owns is created here; a shared home the person also
  // uses outside Opensteer is the driver's to populate, and a profile's own home
  // already exists above.
  if (layout.runnerOwned && layout.directory !== providerHomeDirectory) {
    await mkdir(layout.directory, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(layout.directory);
  }

  return Object.freeze({
    providerState: Object.freeze({
      continuationKey: storeContinuationKey(definition.driverKind, metadata.id),
      kind: definition.stateKind,
      privateStateRoot: resolve(options.privateStateRoot),
      providerHomeDirectory,
      store: Object.freeze({ directory: layout.directory, id: metadata.id }),
    }),
    supersededContinuationKeys: metadata.supersededKeys,
  });
}

/**
 * Reads an already-materialized isolated profile without creating provider
 * state. A profile whose store metadata is missing or unreadable — a process
 * that died between the mkdir and the first metadata write — is still
 * materialized provider state that must be removable, so it is reported with a
 * single-use key that can never be mistaken for a resumable continuation
 * identity.
 */
export async function existingIsolatedHarnessProviderState(
  definition: HarnessInstanceDefinition,
  options: HarnessProviderStateOptions,
): Promise<HarnessProviderState | undefined> {
  if (definition.stateKind !== "isolated") {
    throw new Error("Only isolated harness profiles own removable provider state");
  }
  const root = resolve(options.stateDirectory);
  const directory = profileDirectory(root, definition.id);
  try {
    await stat(directory);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const providerHomeDirectory = join(directory, "provider-home");
  const layout = storeLayout(definition, root, providerHomeDirectory, options);
  const metadata = await readStoreMetadata(layout.metadataDirectory);
  const storeId = metadata?.id ?? `unidentified-${randomUUID()}`;
  return Object.freeze({
    continuationKey: storeContinuationKey(definition.driverKind, storeId),
    kind: "isolated",
    privateStateRoot: resolve(options.privateStateRoot),
    providerHomeDirectory,
    store: Object.freeze({ directory: layout.directory, id: storeId }),
  });
}

/**
 * Deletes exactly one Runner-owned profile directory.
 *
 * A profile's provider home links into a store other profiles still use. The
 * recursive delete removes those links as entries and never follows them, so
 * the store behind them is untouched. Ambient profiles keep no provider files
 * here, so removing one only drops Opensteer's own record and never touches
 * the machine's normal CLI configuration.
 */
export async function removeHarnessProviderState(
  definition: HarnessInstanceDefinition,
  options: Pick<HarnessProviderStateOptions, "stateDirectory" | "storeScope">,
): Promise<void> {
  const root = resolve(options.stateDirectory);
  const directory = profileDirectory(root, definition.id);
  await rm(directory, { force: true, recursive: true });
  // A driver-shared store outlives every profile that ever linked into it; only
  // a store this profile alone owned may be deleted with it.
  if (options.storeScope.kind === "profile") {
    await rm(profileStoreDirectory(root, definition), { force: true, recursive: true });
  }
}

interface HarnessProviderStoreLayout {
  readonly directory: HarnessProviderStore["directory"];
  readonly metadataDirectory: string;
  /** False for an ambient provider home the person also uses outside Opensteer. */
  readonly runnerOwned: boolean;
}

function storeLayout(
  definition: HarnessInstanceDefinition,
  stateDirectory: string,
  providerHomeDirectory: string | undefined,
  options: Pick<HarnessProviderStateOptions, "environment" | "runtimeBoundary" | "storeScope">,
): HarnessProviderStoreLayout {
  if (options.storeScope.kind === "profile") {
    const metadataDirectory = profileStoreDirectory(stateDirectory, definition);
    return {
      // An ambient profile with its own store keeps it wherever the CLI does;
      // the metadata directory stands in as the Runner-owned location.
      directory: providerHomeDirectory ?? metadataDirectory,
      metadataDirectory,
      runnerOwned: true,
    };
  }
  const metadataDirectory = driverStoreDirectory(stateDirectory, definition.driverKind);
  if (options.runtimeBoundary.kind === "isolated-service") {
    return { directory: join(metadataDirectory, "store"), metadataDirectory, runnerOwned: true };
  }
  // On a person's own computer the ambient CLI home is the store, so a profile
  // Opensteer added and the CLI they already had share one conversation history.
  // Opensteer's own metadata deliberately stays under the private state root.
  const directory = nativeUserStoreDirectory(
    options.environment,
    options.storeScope.nativeUserHome,
  );
  return {
    directory,
    // A store the Runner owns is identified by its record; a store the person
    // owns is identified by where it is. Relocating the ambient home therefore
    // selects a different record and publishes a different continuation
    // identity, instead of claiming the previous home's Threads and failing the
    // resume that follows; pointing it back restores the original identity.
    metadataDirectory: join(metadataDirectory, "ambient", ambientStoreKey(directory)),
    runnerOwned: false,
  };
}

/** A short stable digest of the store directory, used only to select its record. */
function ambientStoreKey(storeDirectory: string): string {
  return createHash("sha256").update(storeDirectory).digest("hex").slice(0, 16);
}

function nativeUserStoreDirectory(
  environment: Readonly<Record<string, string>>,
  nativeUserHome: Extract<
    HarnessProviderStoreScope,
    { readonly kind: "driver-shared" }
  >["nativeUserHome"],
): string {
  const configured = environment[nativeUserHome.environmentVariable];
  if (configured) {
    // The CLI would resolve a relative home against each process's own working
    // directory, which makes it a different store per Thread; refusing it is
    // the only answer that keeps one environment one store.
    if (!isAbsolute(configured)) {
      throw new Error(
        `${nativeUserHome.environmentVariable} must be an absolute path to share a provider session store`,
      );
    }
    return resolve(configured);
  }
  const home = environment.HOME;
  return join(home && isAbsolute(home) ? home : homedir(), nativeUserHome.relativeHomePath);
}

function profileDirectory(stateDirectory: string, instanceId: string): string {
  return join(stateDirectory, "harness-profiles", instanceId);
}

function driverStoreDirectory(stateDirectory: string, driverKind: string): string {
  return join(stateDirectory, "harness-stores", driverKind);
}

function profileStoreDirectory(
  stateDirectory: string,
  definition: HarnessInstanceDefinition,
): string {
  return join(
    driverStoreDirectory(stateDirectory, definition.driverKind),
    "profiles",
    definition.id,
  );
}

function storeContinuationKey(driverKind: string, storeId: string): string {
  return `${driverKind}:store:${storeId}`;
}

interface HarnessStoreMetadata {
  readonly id: string;
  readonly supersededKeys: readonly string[];
}

/**
 * Every legacy profile of one driver on one environment adopts into the same
 * store, so the list must hold at least as many keys as an environment may
 * hold profiles. It is bounded only so a corrupt file cannot grow unbounded.
 */
const maxSupersededKeys = 256;
const storeMetadataFileName = "metadata.json";
const legacyMetadataFileName = "profile.json";
const metadataUpdates = new Map<string, Promise<void>>();

async function withStoreMetadataLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = metadataUpdates.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  metadataUpdates.set(directory, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (metadataUpdates.get(directory) === tail) metadataUpdates.delete(directory);
  }
}

function legacyMetadataPath(profileDirectoryPath: string): string {
  return join(profileDirectoryPath, legacyMetadataFileName);
}

/**
 * The continuation key a profile answered under before stores existed. Threads
 * still carry its projection, so adopting a legacy profile has to hand the key
 * to the store that replaced it.
 */
async function readLegacyContinuationKey(
  definition: HarnessInstanceDefinition,
  profileDirectoryPath: string,
): Promise<string | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(legacyMetadataPath(profileDirectoryPath), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { authenticationEpoch, stateId } = record;
  if (typeof stateId !== "string" || !stateId) return undefined;
  if (!Number.isSafeInteger(authenticationEpoch) || (authenticationEpoch as number) < 0) {
    return undefined;
  }
  return `${definition.driverKind}:profile-state:${stateId}:auth:${authenticationEpoch as number}`;
}

async function readStoreMetadata(directory: string): Promise<HarnessStoreMetadata | undefined> {
  try {
    return parseStoreMetadata(await readFile(join(directory, storeMetadataFileName), "utf8"));
  } catch {
    return undefined;
  }
}

async function readOrCreateStoreMetadata(directory: string): Promise<HarnessStoreMetadata> {
  const path = join(directory, storeMetadataFileName);
  try {
    return parseStoreMetadata(await readFile(path, "utf8"));
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  const initial: HarnessStoreMetadata = { id: randomUUID(), supersededKeys: [] };
  try {
    await writeFile(path, `${JSON.stringify(initial)}\n`, { flag: "wx", mode: 0o600 });
    return initial;
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    return parseStoreMetadata(await readFile(path, "utf8"));
  }
}

async function writeStoreMetadata(
  directory: string,
  metadata: HarnessStoreMetadata,
): Promise<void> {
  const path = join(directory, storeMetadataFileName);
  const temporary = join(directory, `.store-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await setPrivateFileMode(path);
}

function parseStoreMetadata(serialized: string): HarnessStoreMetadata {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid harness store metadata");
  const record = value as Record<string, unknown>;
  const superseded = record.supersededKeys ?? [];
  if (
    typeof record.id !== "string" ||
    !record.id ||
    !Array.isArray(superseded) ||
    superseded.length > maxSupersededKeys ||
    superseded.some((key) => typeof key !== "string" || !key)
  ) {
    throw new Error("Invalid harness store metadata");
  }
  return {
    id: record.id,
    supersededKeys: superseded as string[],
  };
}
