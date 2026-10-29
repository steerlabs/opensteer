import { homedir } from "node:os";
import {
  defaultSignedHelperRun,
  ensureSignedHelperInstalled,
  readBundleVersion,
  signedHelperLifecycleLockFlags,
  signedHelperSignaturePolicy,
  verifySignedHelperSignature,
  withSignedHelperLifecycleLock,
  type InstalledSignedHelper,
  type SignedHelperDeadline,
  type SignedHelperIdentity,
  type SignedHelperProcess,
  type SignedHelperSignature,
  type SignedHelperSignaturePolicy,
} from "../signed-helpers/signed-helper.js";
import {
  computerUseHelperAppName,
  computerUseHelperAppPath,
  computerUseHelperBundleId,
  computerUseHelperExecutableName,
  computerUseHelperLockPath,
  computerUseHelperNotBuiltMessage,
  computerUseHelperRoot,
} from "./helper-paths.js";
import { computerUseHelperRequirement } from "./release-identity.js";

export {
  compareBundleVersions,
  isAdHocSignature,
  readBundleVersion,
} from "../signed-helpers/signed-helper.js";

/**
 * The flags that open the lifecycle lock, or null where the OS has no
 * lock-on-open; see `signedHelperLifecycleLockFlags`.
 */
export const computerUseLifecycleLockFlags: number | null = signedHelperLifecycleLockFlags;

/** The lifecycle lock stayed held by somebody else until the waiter's deadline. */
export class ComputerUseLifecycleLockBusy extends Error {
  constructor() {
    super("Another Opensteer is starting or updating Computer use. Try again shortly.");
    this.name = "ComputerUseLifecycleLockBusy";
  }
}

export type ComputerUseHelperProcess = SignedHelperProcess;

/**
 * When a piece of work must be done by, in the caller's clock. `at` is read at
 * every step rather than once, so a caller that joins shared work already in
 * flight can extend it to its own deadline.
 */
export type ComputerUseDeadline = SignedHelperDeadline;

/** `Opensteer Computer Use.app` as the shared install, lock and launch steps name it. */
export const computerUseHelperIdentity: SignedHelperIdentity = {
  appName: computerUseHelperAppName,
  bundleId: computerUseHelperBundleId,
  executableName: computerUseHelperExecutableName,
  label: "Computer use helper",
  lockBusy: () => new ComputerUseLifecycleLockBusy(),
  logPrefix: "desktop.computer-use.helper",
  notBuiltMessage: computerUseHelperNotBuiltMessage,
  peerLabel: "Computer use",
  requirement: computerUseHelperRequirement,
  unsupportedPlatformMessage: "Computer use runs only on macOS.",
};

export interface EnsureHelperInstalledOptions {
  /** The helper this build ships, already resolved for packaged/development. */
  readonly bundledAppPath: string;
  /** How long waiting for the lifecycle lock may take. */
  readonly deadline: ComputerUseDeadline;
  readonly homeDirectory?: string;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  readonly run?: ComputerUseHelperProcess;
  /** Null only for a development desktop, where an ad-hoc helper is allowed. */
  readonly teamId: string | null;
}

export type InstalledComputerUseHelper = InstalledSignedHelper;

export interface ComputerUseHelperLifecycleLockOptions {
  /** When to stop waiting for another holder; the operation itself is not bounded. */
  readonly deadline: ComputerUseDeadline;
  readonly lockPath: string;
  readonly now?: () => number;
}

/**
 * Serializes every operation that can launch or replace the one canonical
 * helper; see `withSignedHelperLifecycleLock`.
 */
export async function withComputerUseHelperLifecycleLock<T>(
  options: ComputerUseHelperLifecycleLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  return await withSignedHelperLifecycleLock(
    { ...options, identity: computerUseHelperIdentity },
    operation,
  );
}

/**
 * Puts this build's helper at the canonical path when it is absent, invalid or
 * older; see `ensureSignedHelperInstalled`. Stable and Beta share this path,
 * which is what lets the two apps share one pair of macOS grants.
 */
export async function ensureHelperInstalled(
  options: EnsureHelperInstalledOptions,
): Promise<InstalledComputerUseHelper> {
  const home = options.homeDirectory ?? homedir();
  return await ensureSignedHelperInstalled({
    bundledAppPath: options.bundledAppPath,
    deadline: options.deadline,
    identity: computerUseHelperIdentity,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.now === undefined ? {} : { now: options.now }),
    paths: {
      app: computerUseHelperAppPath(home),
      lock: computerUseHelperLockPath(home),
      root: computerUseHelperRoot(home),
    },
    ...(options.run === undefined ? {} : { run: options.run }),
    teamId: options.teamId,
  });
}

/**
 * The version of the helper at the canonical path, or null when there is none.
 *
 * It reads and installs nothing, which is what lets a readiness probe tell a
 * Mac where computer use was never set up from one whose helper is only asleep.
 */
export async function installedComputerUseHelperVersion(options: {
  readonly homeDirectory?: string;
  readonly run?: ComputerUseHelperProcess;
}): Promise<string | null> {
  return readBundleVersion(
    options.run ?? defaultSignedHelperRun,
    computerUseHelperAppPath(options.homeDirectory),
  );
}

export type ComputerUseHelperSignature = SignedHelperSignature;
export type ComputerUseHelperSignaturePolicy = SignedHelperSignaturePolicy;

/** Holds the helper this build bundles to the build's own signing policy. */
export async function verifyBundledComputerUseHelper(options: {
  readonly bundledAppPath: string;
  readonly run?: ComputerUseHelperProcess;
  readonly teamId: string | null;
}): Promise<void> {
  await verifyComputerUseHelperSignature(
    options.run ?? defaultSignedHelperRun,
    options.bundledAppPath,
    signedHelperSignaturePolicy(options.teamId),
  );
}

/** Verifies bundle integrity and then pins its identity to this product. */
export async function verifyComputerUseHelperSignature(
  run: ComputerUseHelperProcess,
  appPath: string,
  policy: ComputerUseHelperSignaturePolicy,
): Promise<ComputerUseHelperSignature> {
  return await verifySignedHelperSignature(run, appPath, computerUseHelperIdentity, policy);
}
