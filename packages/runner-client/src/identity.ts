import {
  createPrivateFileAtomically,
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { isNodeError } from "@opensteer/shared/nodeError";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { open, rm, stat, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  EnvironmentIdSchema,
  RunnerIdSchema,
  createId,
  type EnvironmentId,
  type ProviderContinuationIdentity,
  type RunnerId,
} from "@opensteer/core";
import { z } from "zod";

const maximumIdentityBytes = 48 * 1_024;
const IdentityFileSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  /**
   * Null for a computer that runs no agents. A browser or messaging Runner has
   * no work location, and inventing one would make it look dispatchable.
   */
  environmentId: EnvironmentIdSchema.nullable(),
  lastConnectionGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  privateKeyPem: z.string().min(64).max(16_384),
  publicKeyPem: z.string().min(64).max(16_384),
  runnerId: RunnerIdSchema,
  version: z.literal(3),
});

// Version 3 only made environmentId nullable so module-only Runners could omit
// a work location. Existing agent Runners have a non-null version 2 binding;
// accepting that exact shape preserves their enrolled key and Host lineage.
const LegacyIdentityFileSchema = IdentityFileSchema.extend({
  environmentId: EnvironmentIdSchema,
  version: z.literal(2),
});
const PersistedIdentityFileSchema = z.union([IdentityFileSchema, LegacyIdentityFileSchema]);

export interface RunnerIdentity {
  readonly createdAt: string;
  readonly environmentId: EnvironmentId | null;
  readonly lastConnectionGeneration: number;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeyPem: string;
  readonly runnerId: RunnerId;
  readonly version: 3;
}

export interface RunnerIdentityOptions {
  readonly dataDirectory: string;
  readonly environmentId?: EnvironmentId;
  /** True for a Runner with no agents module, which needs no work location. */
  readonly environmentless?: boolean;
  readonly runnerId?: RunnerId;
}

export interface RunnerIdentityDescriptor {
  readonly enrolled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly runnerId: RunnerId;
}

/** The Runner-private continuation source the Runner composes for one profile. */
interface ProviderContinuationSource {
  readonly continuationKey: string;
  readonly driverKind: ProviderContinuationIdentity["driverKind"];
}

export type ProviderContinuationIdentityProjector = (
  identity: ProviderContinuationSource,
) => ProviderContinuationIdentity;

/**
 * Replace a provider's private state-store path with a stable Runner-scoped
 * identifier before it crosses the Runner boundary. Signing makes the value
 * deterministic for this persisted Runner identity without making filesystem
 * paths guessable from public Runner metadata.
 */
export function providerContinuationIdentityProjector(
  privateKey: KeyObject,
): ProviderContinuationIdentityProjector {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Provider continuation projection requires the Runner Ed25519 private key");
  }
  return (identity) => {
    const transcript = Buffer.from(
      JSON.stringify([
        "opensteer-provider-continuation-identity-v1",
        identity.driverKind,
        identity.continuationKey,
      ]),
      "utf8",
    );
    const fingerprint = createHash("sha256")
      .update(sign(null, transcript, privateKey))
      .digest("base64url");
    return {
      continuationKey: `runner:v1:${fingerprint}`,
      driverKind: identity.driverKind,
    };
  };
}

export async function inspectRunnerIdentity(
  dataDirectory: string,
): Promise<RunnerIdentityDescriptor | null> {
  const identity = await readIdentity(join(resolve(dataDirectory), "identity.json"), false);
  return identity
    ? {
        enrolled: identity.lastConnectionGeneration > 0,
        environmentId: identity.environmentId,
        runnerId: identity.runnerId,
      }
    : null;
}

export class FileRunnerIdentityStore {
  readonly #directory: string;
  readonly #environmentId: EnvironmentId | undefined;
  readonly #environmentless: boolean;
  readonly #identityPath: string;
  readonly #runnerId: RunnerId | undefined;

  constructor(options: RunnerIdentityOptions) {
    this.#directory = resolve(options.dataDirectory);
    this.#environmentId = options.environmentId;
    this.#environmentless = options.environmentless ?? false;
    this.#identityPath = join(this.#directory, "identity.json");
    this.#runnerId = options.runnerId;
  }

  async loadOrCreate(): Promise<RunnerIdentity> {
    await securePrivateDirectory(this.#directory);
    const existing = await readIdentity(this.#identityPath, true);
    if (existing) {
      assertConfiguredIdentity(existing, {
        ...(this.#environmentId ? { environmentId: this.#environmentId } : {}),
        ...(this.#runnerId ? { runnerId: this.#runnerId } : {}),
      });
      return existing;
    }

    const pair = generateKeyPairSync("ed25519");
    const file = IdentityFileSchema.parse({
      createdAt: new Date().toISOString(),
      environmentId: this.#environmentless
        ? null
        : (this.#environmentId ?? createId("environment")),
      lastConnectionGeneration: 0,
      privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId: this.#runnerId ?? createId("runner"),
      version: 3,
    });
    await createPrivateFileAtomically(
      this.#identityPath,
      `${JSON.stringify(file, undefined, 2)}\n`,
    );
    const stored = await readIdentity(this.#identityPath, false);
    if (!stored) throw new Error("Runner identity disappeared after it was created");
    assertConfiguredIdentity(stored, {
      ...(this.#environmentId ? { environmentId: this.#environmentId } : {}),
      ...(this.#runnerId ? { runnerId: this.#runnerId } : {}),
    });
    return stored;
  }

  async acceptHostConnection(input: {
    readonly connectionGeneration: number;
    readonly environmentIds: readonly EnvironmentId[];
    readonly reenrolled: boolean;
    readonly runnerId: RunnerId;
  }): Promise<RunnerIdentity> {
    const current = await readIdentity(this.#identityPath, false);
    if (!current) throw new Error("Runner identity is missing");
    if (input.runnerId !== current.runnerId) {
      throw new Error("Host acknowledged a different Runner identity");
    }
    const acknowledged = current.environmentId === null ? [] : [current.environmentId];
    // A Runner that advertises no agents module is acknowledged with no
    // environment at all, which is not a changed binding: its saved work
    // location stays on disk for the day the same computer runs agents again.
    if (
      input.environmentIds.length > 0 &&
      (input.environmentIds.length !== acknowledged.length ||
        input.environmentIds.some((environmentId, index) => environmentId !== acknowledged[index]))
    ) {
      throw new Error("Host acknowledged a different execution environment binding");
    }
    if (!input.reenrolled && input.connectionGeneration <= current.lastConnectionGeneration) {
      throw new Error("Host Runner connection generation did not advance");
    }
    const file = IdentityFileSchema.parse({
      createdAt: current.createdAt,
      environmentId: current.environmentId,
      lastConnectionGeneration: input.connectionGeneration,
      privateKeyPem: current.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem: current.publicKeyPem,
      runnerId: current.runnerId,
      version: 3,
    });
    await replacePrivateFileAtomically(
      this.#identityPath,
      `${JSON.stringify(file, undefined, 2)}\n`,
    );
    const stored = await readIdentity(this.#identityPath, false);
    if (!stored) throw new Error("Updated Runner identity is missing");
    return stored;
  }
}

export async function loadOrCreateRunnerIdentity(
  options: RunnerIdentityOptions,
): Promise<RunnerIdentity> {
  return new FileRunnerIdentityStore(options).loadOrCreate();
}

/**
 * How often the owner refreshes its claim on the data directory. A renewal is
 * one `utimes`, so the cadence can be brisk without costing anything.
 */
const lockRenewalIntervalMs = 2_000;

/**
 * A lease untouched for this long is presumed abandoned. Seven missed renewals
 * is long enough that a stop-the-world pause, a slow volume, or a suspended
 * laptop never costs a live Runner its lock, and short enough that a container
 * whose predecessor was killed without releasing starts within seconds instead
 * of crash-looping forever.
 */
const lockStaleAfterMs = 15_000;

/**
 * A seam for tests, which cannot afford to wait out the real window. Production
 * always uses the constants above; there is no configuration surface for them.
 */
export interface RunnerDataDirectoryLockTimings {
  readonly renewalIntervalMs?: number;
  readonly staleAfterMs?: number;
}

/**
 * Exclusive ownership of a Runner data directory, held as a renewed lease.
 *
 * The recorded pid is informational only. Process liveness cannot decide
 * ownership here: every container restart is a fresh PID namespace, so a
 * successor lands on the same low pid its dead predecessor wrote and would read
 * its own abandoned lock as held by a living process. What a successor can
 * trust is that nobody has touched the file — a lease nothing has renewed for a
 * whole staleness window has no owner, whatever it claims about itself.
 */
export class RunnerDataDirectoryLock {
  readonly #directory: string;
  readonly #path: string;
  readonly #nonce: string;
  readonly #renewalIntervalMs: number;
  #handle: Awaited<ReturnType<typeof open>> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #renewing = false;
  #lostReason: Error | undefined;
  #onLost: ((reason: Error) => void) | undefined;

  private constructor(directory: string, path: string, nonce: string, renewalIntervalMs: number) {
    this.#directory = directory;
    this.#path = path;
    this.#nonce = nonce;
    this.#renewalIntervalMs = renewalIntervalMs;
  }

  static async acquire(
    runtimeDirectory: string,
    timings: RunnerDataDirectoryLockTimings = {},
  ): Promise<RunnerDataDirectoryLock> {
    const renewalIntervalMs = timings.renewalIntervalMs ?? lockRenewalIntervalMs;
    const staleAfterMs = timings.staleAfterMs ?? lockStaleAfterMs;
    const directory = resolve(runtimeDirectory);
    await securePrivateDirectory(directory);
    const path = join(directory, ".runner.lock");
    const held = (): Error => new Error(`Another Opensteer Runner is already using ${directory}`);
    // The whole contest is bounded: one window to prove the lease is dead, plus
    // a renewal interval of slack for the owner's next tick to land.
    const giveUpAt = Date.now() + staleAfterMs + renewalIntervalMs;
    let firstSeenAt: number | undefined;
    let firstSeenMtimeMs: number | undefined;

    for (;;) {
      const lock = await RunnerDataDirectoryLock.#create(directory, path, renewalIntervalMs);
      if (lock) return lock;

      const now = Date.now();
      if (now > giveUpAt) throw held();
      const existing = await stat(path).catch(() => undefined);
      // The owner released it between our create and our stat; race again.
      if (!existing) continue;

      if (firstSeenMtimeMs === undefined) {
        firstSeenAt = now;
        firstSeenMtimeMs = existing.mtimeMs;
      } else if (existing.mtimeMs !== firstSeenMtimeMs) {
        // The lease moved while we watched, so somebody is renewing it and no
        // amount of further waiting will make this directory ours.
        throw held();
      }

      // Staleness comes from mtime, which the kernel stamps on the renewal
      // write, rather than from a timestamp the owner writes into the file: the
      // owner cannot misreport it and a renewal stays a single cheap syscall.
      // Two rules, because the two clocks involved need not agree. The absolute
      // one is the fast path and covers the case that matters — a container
      // whose predecessor died finds an ancient lock and starts at once. The
      // second compares nothing across clocks, only that this mtime value never
      // changed while we waited out a full window, so a volume carrying another
      // node's clock still recovers instead of hanging.
      const stale =
        now - existing.mtimeMs >= staleAfterMs || now - (firstSeenAt ?? now) >= staleAfterMs;
      if (!stale) {
        await sleep(Math.max(25, Math.floor(renewalIntervalMs / 4)));
        continue;
      }

      // An unreadable or unparseable lock is reclaimed on exactly these terms:
      // its content was never the evidence of ownership, and a file nothing has
      // renewed for a full window is abandoned whatever it happens to contain.
      await rm(path, { force: true });
    }
  }

  /**
   * The lease was taken by another process: this Runner no longer owns its data
   * directory and must stop. Registered after `acquire` so the caller can wire
   * it into the same shutdown path as an external abort.
   */
  onLost(listener: (reason: Error) => void): void {
    this.#onLost = listener;
    if (this.#lostReason) listener(this.#lostReason);
  }

  async release(): Promise<void> {
    this.#stopRenewing();
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await handle.close();
    const current = await readIdentityFile(this.#path).catch(() => undefined);
    if (!current) return;
    try {
      const parsed = JSON.parse(current) as { nonce?: unknown };
      if (parsed.nonce === this.#nonce) await rm(this.#path, { force: true });
    } catch {
      // Do not remove a lock whose ownership cannot be proven.
    }
  }

  static async #create(
    directory: string,
    path: string,
    renewalIntervalMs: number,
  ): Promise<RunnerDataDirectoryLock | undefined> {
    const nonce = randomUUID();
    const lock = new RunnerDataDirectoryLock(directory, path, nonce, renewalIntervalMs);
    try {
      lock.#handle = await open(path, "wx", 0o600);
      await lock.#handle.writeFile(
        `${JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await lock.#handle.sync();
    } catch (error) {
      await lock.#handle?.close().catch(() => undefined);
      lock.#handle = undefined;
      if (isNodeError(error) && error.code === "EEXIST") return undefined;
      throw error;
    }
    lock.#startRenewing();
    return lock;
  }

  #startRenewing(): void {
    const timer = setInterval(() => void this.#renew(), this.#renewalIntervalMs);
    // A held lease is not a reason for the process to stay alive.
    timer.unref?.();
    this.#timer = timer;
  }

  #stopRenewing(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Never throws: a renewal that fails leaves the verdict to the next tick. */
  async #renew(): Promise<void> {
    if (this.#renewing || this.#lostReason || !this.#handle) return;
    this.#renewing = true;
    try {
      if (!(await this.#ownsLockFile())) {
        this.#lose();
        return;
      }
      const now = new Date();
      await utimes(this.#path, now, now);
    } catch {
      // A transient filesystem error is not proof the lease was taken.
    } finally {
      this.#renewing = false;
    }
  }

  async #ownsLockFile(): Promise<boolean> {
    const content = await readIdentityFile(this.#path);
    if (content === undefined) return false;
    try {
      return (JSON.parse(content) as { nonce?: unknown }).nonce === this.#nonce;
    } catch {
      return false;
    }
  }

  #lose(): void {
    if (this.#lostReason) return;
    this.#stopRenewing();
    this.#lostReason = new Error(
      `Another process took the Opensteer Runner lock on ${this.#directory}`,
    );
    this.#onLost?.(this.#lostReason);
  }
}

function assertConfiguredIdentity(
  identity: RunnerIdentity,
  options: Pick<RunnerIdentityOptions, "environmentId" | "runnerId">,
): void {
  if (options.runnerId && options.runnerId !== identity.runnerId) {
    throw new Error(
      `OPENSTEER_RUNNER_ID does not match the persisted Runner identity (${identity.runnerId})`,
    );
  }
  if (options.environmentId && options.environmentId !== identity.environmentId) {
    throw new Error(
      `OPENSTEER_ENVIRONMENT_ID does not match the persisted Runner identity (${identity.environmentId})`,
    );
  }
}

async function readIdentity(
  path: string,
  upgradeLegacy: boolean,
): Promise<RunnerIdentity | undefined> {
  const content = await readIdentityFile(path);
  if (content === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error("Runner identity file contains invalid JSON", { cause: error });
  }
  const file = PersistedIdentityFileSchema.parse(value);
  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = createPrivateKey(file.privateKeyPem);
    publicKey = createPublicKey(file.publicKeyPem);
  } catch (error) {
    throw new Error("Runner identity file contains an invalid key", { cause: error });
  }
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Runner identity keys must be Ed25519");
  }
  const probe = Buffer.from("opensteer-runner-key-pair-check", "utf8");
  if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) {
    throw new Error("Runner identity key pair does not match");
  }
  if (file.version === 2 && upgradeLegacy) {
    const upgraded = IdentityFileSchema.parse({ ...file, version: 3 });
    await replacePrivateFileAtomically(path, `${JSON.stringify(upgraded, undefined, 2)}\n`);
  }
  return {
    createdAt: file.createdAt,
    environmentId: file.environmentId,
    lastConnectionGeneration: file.lastConnectionGeneration,
    privateKey,
    publicKey,
    publicKeyPem: file.publicKeyPem,
    runnerId: file.runnerId,
    version: 3,
  };
}

async function readIdentityFile(path: string): Promise<string | undefined> {
  return readPrivateFileText(path, maximumIdentityBytes, {
    exposed: () => new Error("Runner identity or lock file must not be accessible by other users"),
    invalid: () => new Error("Runner identity or lock file is invalid"),
  });
}
