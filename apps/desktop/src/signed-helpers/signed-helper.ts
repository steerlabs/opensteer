import { signedHelperProtocolVersionKey } from "./metadata.js";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { delay } from "@opensteer/shared/delay";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { setPrivateDirectoryMode } from "@opensteer/shared/privateFiles";
import { opensteerAppleTeamId } from "./developer-id.js";

/**
 * The install, lock and launch primitives every separately signed helper app
 * shares: `Opensteer Computer Use.app` and `Opensteer Passwords.app`. Each
 * helper names itself with a `SignedHelperIdentity`; the sequence is the same.
 */

const execFileAsync = promisify(execFile);

/** A plist is metadata; nothing here should ever read megabytes of it. */
const maximumProcessOutputBytes = 4 * 1_024 * 1_024;
const firstLockRetryMs = 10;
const longestLockRetryMs = 200;
const maximumPeerVerifierErrorBytes = 16 * 1_024;

/**
 * darwin's `O_EXLOCK`: `open(2)` takes an exclusive `flock(2)` lock on the
 * file as part of opening it. Node's `fs.constants` omits it (Node 24, and the
 * Node inside the Electron this app ships), so the value is the one
 * `<sys/fcntl.h>` in the macOS SDK defines, `0x00000020`: unchanged since
 * 4.4BSD and part of the kernel ABI. The lock tests prove it excludes a second
 * opener. Linux has no such flag and ignores unknown ones, which would be no
 * lock at all, so no other platform gets it.
 */
const darwinExclusiveLockFlag = 0x20;

/**
 * The flags that open a lifecycle lock, or null where the OS has no
 * lock-on-open. `O_NONBLOCK` turns a held lock into `EAGAIN` rather than a
 * wait nobody could bound, and libuv adds `O_CLOEXEC`, so no program this app
 * starts — `ditto`, `open`, the helper — inherits the lock.
 */
export const signedHelperLifecycleLockFlags: number | null =
  process.platform === "darwin"
    ? constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | darwinExclusiveLockFlag
    : null;

export interface SignedHelperProcess {
  (file: string, arguments_: readonly string[]): Promise<string>;
}

/**
 * When a piece of work must be done by, in the caller's clock. `at` is read at
 * every step rather than once, so a caller that joins shared work already in
 * flight can extend it to its own deadline.
 */
export interface SignedHelperDeadline {
  readonly at: number;
}

/** Who a helper is, and how its failures and log events name it. */
export interface SignedHelperIdentity {
  /** The bundle's folder name, e.g. `Opensteer Computer Use.app`. */
  readonly appName: string;
  readonly bundleId: string;
  /** `Contents/MacOS/<name>`, which `--prepare-replacement` and `--verify-peer` run. */
  readonly executableName: string;
  /** The subject of every signature sentence, e.g. `Computer use helper`. */
  readonly label: string;
  /** Every install log event is this followed by `-installed` and so on. */
  readonly logPrefix: string;
  /** The waiter's refusal when another holder keeps the lifecycle lock past its deadline. */
  readonly lockBusy: () => Error;
  readonly notBuiltMessage: string;
  /** The subject of the peer verifier's sentences, e.g. `Computer use`. */
  readonly peerLabel: string;
  /** The Developer ID requirement a non-ad-hoc build must satisfy. */
  readonly requirement: (teamId: string) => string;
  /** Off macOS there is no lifecycle lock, and nothing that would need one. */
  readonly unsupportedPlatformMessage: string;
}

/** Where one helper lives once installed: the 0700 root, the bundle and the lock. */
export interface SignedHelperInstallPaths {
  readonly app: string;
  readonly lock: string;
  readonly root: string;
}

export function signedHelperExecutablePath(
  identity: Pick<SignedHelperIdentity, "executableName">,
  appPath: string,
): string {
  return path.join(appPath, "Contents", "MacOS", identity.executableName);
}

export interface SignedHelperLifecycleLockOptions {
  /** When to stop waiting for another holder; the operation itself is not bounded. */
  readonly deadline: SignedHelperDeadline;
  readonly identity: Pick<SignedHelperIdentity, "lockBusy" | "unsupportedPlatformMessage">;
  readonly lockPath: string;
  readonly now?: () => number;
}

/**
 * Serializes every operation that can launch or replace one canonical helper.
 * Holding this through socket readiness keeps a second Desktop from launching
 * the outgoing bundle while another Desktop is replacing it.
 *
 * The lock is the kernel's: an exclusive `flock` taken as the file opens and
 * released when the descriptor closes, including when its process dies however
 * it dies. No holder is ever judged dead by a pid or an age, so none can be
 * broken while it is alive. The file stays and is never removed: unlinking a
 * locked file would let the next Opensteer lock a new one beside it. A waiter
 * polls, backing off, until it holds the lock or its deadline passes.
 */
export async function withSignedHelperLifecycleLock<T>(
  options: SignedHelperLifecycleLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireLifecycleLock(options);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export interface EnsureSignedHelperInstalledOptions {
  /** The helper this build ships, already resolved for packaged/development. */
  readonly bundledAppPath: string;
  /** How long waiting for the lifecycle lock may take. */
  readonly deadline: SignedHelperDeadline;
  readonly identity: SignedHelperIdentity;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  readonly paths: SignedHelperInstallPaths;
  readonly run?: SignedHelperProcess;
  /** Null only for a development desktop, where an ad-hoc helper is allowed. */
  readonly teamId: string | null;
}

export interface InstalledSignedHelper {
  /** True only when this call is what put these bytes there. */
  readonly installed: boolean;
  /**
   * True when this call replaced a bundle whose running copy could neither be
   * verified nor asked to quit. That process still holds the socket, so the
   * next launch starts a new instance rather than talking to it.
   */
  readonly launchFreshInstance: boolean;
  readonly path: string;
  /** The newest protocol the helper's bundle declares, or null when it declares none. */
  readonly protocolVersion: number | null;
  readonly version: string;
}

/**
 * Puts this build's helper at the canonical path when it is absent, invalid or
 * older. Older is decided by the newest protocol each bundle declares first
 * and its version second. Development also replaces equal-version bytes when
 * their code hash changed. A release helper of the same protocol and version
 * is kept whatever its hash: Stable and Beta each build and sign their own
 * copy of one release, so two valid bundles of one version are the same
 * helper to this app.
 *
 * The copy is made beside the destination with `ditto --noqtn` — a quarantine
 * flag on a helper macOS is about to hand privileges to is exactly the kind of
 * surprise that makes a feature fail on somebody else's Mac — verified where it
 * lands. The staged helper then asks an exact signed canonical helper to stop
 * before its bundle is renamed. This whole transition holds the same lock
 * every launch holds through socket readiness, so two Opensteers cannot launch
 * the outgoing helper or interleave installs. A valid newer helper is never
 * replaced by an older one: Stable and Beta share this path, and the newest
 * installed app is the one that decides which helper it holds. An invalid
 * bundle has no version authority and is replaced.
 */
export async function ensureSignedHelperInstalled(
  options: EnsureSignedHelperInstalledOptions,
): Promise<InstalledSignedHelper> {
  const { identity, paths } = options;
  const run = options.run ?? defaultSignedHelperRun;
  const log = options.log ?? (() => undefined);
  const appPath = paths.app;
  const bundled = await readBundleInfo(run, options.bundledAppPath);
  if (bundled === null) throw new Error(identity.notBuiltMessage);
  const policy = signedHelperSignaturePolicy(options.teamId);
  const bundledSignature = await verifySignedHelperSignature(
    run,
    options.bundledAppPath,
    identity,
    policy,
  );

  const current = await readBundleInfo(run, appPath);
  const currentSignature =
    current === null
      ? null
      : await verifySignedHelperSignature(run, appPath, identity, policy).catch(
          (error: unknown) => {
            log(`${identity.logPrefix}-installed-invalid`, {
              message: error instanceof Error ? error.message : "signature verification failed",
            });
            return null;
          },
        );
  if (
    current !== null &&
    currentSignature !== null &&
    shouldKeepInstalled({
      bundled,
      bundledSignature,
      current,
      currentSignature,
      development: options.teamId === null,
    })
  ) {
    return { installed: false, launchFreshInstance: false, path: appPath, ...current };
  }

  await mkdir(paths.root, { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(paths.root);
  return withSignedHelperLifecycleLock(
    {
      deadline: options.deadline,
      identity,
      lockPath: paths.lock,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
    async () => {
      // Re-read under the lock: the Opensteer that held it may have been a newer
      // build installing the very helper this one was about to replace.
      const held = await readBundleInfo(run, appPath);
      const heldSignature =
        held === null
          ? null
          : await verifySignedHelperSignature(run, appPath, identity, policy).catch(() => null);
      if (
        held !== null &&
        heldSignature !== null &&
        shouldKeepInstalled({
          bundled,
          bundledSignature,
          current: held,
          currentSignature: heldSignature,
          development: options.teamId === null,
        })
      ) {
        return { installed: false, launchFreshInstance: false, path: appPath, ...held };
      }
      const stamp = `${process.pid}-${(options.now ?? Date.now)()}`;
      const stagingDirectory = path.join(paths.root, `.install-${stamp}`);
      const stagedApp = path.join(stagingDirectory, identity.appName);
      await rm(stagingDirectory, { force: true, recursive: true });
      await mkdir(stagingDirectory, { mode: 0o700, recursive: true });
      try {
        await run("/usr/bin/ditto", ["--noqtn", options.bundledAppPath, stagedApp]);
        await verifySignedHelperSignature(run, stagedApp, identity, policy);
        const displaced = path.join(paths.root, `.previous-${stamp}`);
        const hadPrevious = await pathExists(appPath);
        let launchFreshInstance = false;
        if (hadPrevious) {
          // Run from the copy sealed inside this app, never the staged one: the
          // staging directory is writable by any process of this user, so its
          // executable is not necessarily the bytes just verified. The helper
          // finds the running copy by its canonical path, not its own.
          const refusal = await run(signedHelperExecutablePath(identity, options.bundledAppPath), [
            "--prepare-replacement",
          ]).then(
            () => null,
            (error: unknown) => (error instanceof Error ? error.message : "refused"),
          );
          if (refusal !== null) {
            log(`${identity.logPrefix}-replacement-refused`, {
              installed: heldSignature === null ? "invalid" : "valid",
              message: refusal,
            });
            // A valid helper that would not stop in time is still a helper
            // this app can talk to, and the replacement is tried again on the
            // next connection. Keeping it is also what leaves a live session
            // of the other channel running.
            if (held !== null && heldSignature !== null) {
              return { installed: false, launchFreshInstance: false, path: appPath, ...held };
            }
            // An invalid bundle has no authority to keep, and whatever runs
            // from it fails peer verification, so waiting for it would refuse
            // this Mac forever. Renaming never rewrites the running bytes, and
            // the new instance takes the socket from the old one, which then
            // has nobody to serve and quits on its own idle timer.
            launchFreshInstance = true;
          }
        }
        if (hadPrevious) await rename(appPath, displaced);
        try {
          await rename(stagedApp, appPath);
        } catch (error) {
          if (hadPrevious) await rename(displaced, appPath).catch(() => undefined);
          throw error;
        }
        await rm(displaced, { force: true, recursive: true });
        log(`${identity.logPrefix}-installed`, {
          from: current?.version ?? "none",
          to: bundled.version,
        });
        return { installed: true, launchFreshInstance, path: appPath, ...bundled };
      } finally {
        await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
      }
    },
  );
}

export interface SignedHelperSignature {
  readonly adHoc: boolean;
  readonly cdHash: string;
}

/** A packaged build refuses an ad-hoc helper; a page can say so instead of failing silently. */
export class AdHocSignedHelperError extends Error {
  constructor(label: string) {
    super(`${label} is ad-hoc signed in a packaged build.`);
    this.name = "AdHocSignedHelperError";
  }
}

export interface SignedHelperSignaturePolicy {
  readonly allowAdHoc: boolean;
  readonly expectedTeamId: string;
}

/**
 * A development desktop (no team) accepts an ad-hoc helper; anything not
 * ad-hoc is still held to Opensteer's team.
 */
export function signedHelperSignaturePolicy(teamId: string | null): SignedHelperSignaturePolicy {
  return {
    allowAdHoc: teamId === null,
    expectedTeamId: teamId ?? opensteerAppleTeamId,
  };
}

/** Verifies bundle integrity and then pins its identity to this product. */
export async function verifySignedHelperSignature(
  run: SignedHelperProcess,
  appPath: string,
  identity: Pick<SignedHelperIdentity, "bundleId" | "label" | "requirement">,
  policy: SignedHelperSignaturePolicy,
): Promise<SignedHelperSignature> {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const description = await run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const adHoc = isAdHocSignature(description);
  // An ad-hoc package also carries the development identifier; its signature
  // is the reason a packaged build refuses it.
  if (adHoc && !policy.allowAdHoc) throw new AdHocSignedHelperError(identity.label);
  const identifier = matchLine(description, /^Identifier=(.+)$/mu);
  if (identifier !== identity.bundleId) {
    throw new Error(`${identity.label} has the wrong bundle identifier.`);
  }
  if (!adHoc) {
    await run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      `-R=${identity.requirement(policy.expectedTeamId)}`,
      appPath,
    ]).catch((error: unknown) => {
      throw new Error(`${identity.label} is not signed by Opensteer.`, { cause: error });
    });
  }
  const cdHash = matchLine(description, /^CDHash=(.+)$/mu);
  if (!cdHash) throw new Error(`${identity.label} signature has no code-directory hash.`);
  return { adHoc, cdHash };
}

/** `codesign` prints its description on stderr, which the port folds in. */
export function isAdHocSignature(description: string): boolean {
  return /^Signature=adhoc$/mu.test(description);
}

/**
 * The `Info.plist` key under which a helper's build declares the newest
 * protocol the helper speaks, as a positive integer.
 */
export { signedHelperProtocolVersionKey } from "./metadata.js";

/** One bundle's `CFBundleVersion`, or null when there is no bundle to read. */
export async function readBundleVersion(
  run: SignedHelperProcess,
  appPath: string,
): Promise<string | null> {
  return (await readBundleInfo(run, appPath))?.version ?? null;
}

interface SignedHelperBundleInfo {
  /** Null for a helper built before helpers declared one, which speaks an older protocol. */
  readonly protocolVersion: number | null;
  readonly version: string;
}

/**
 * One bundle's `CFBundleVersion` and declared protocol, or null when there is
 * no bundle to read.
 *
 * `plutil` ships with macOS, so the plist is read by the tool that owns the
 * format rather than by a parser this repository would then have to keep
 * correct for binary plists.
 */
async function readBundleInfo(
  run: SignedHelperProcess,
  appPath: string,
): Promise<SignedHelperBundleInfo | null> {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  try {
    const metadata = await lstat(plistPath);
    if (!metadata.isFile()) return null;
  } catch {
    return null;
  }
  let output: string;
  try {
    output = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const plist = decoded as Record<string, unknown>;
  const version = plist.CFBundleVersion;
  if (typeof version !== "string" || version.trim().length === 0) return null;
  const declared = plist[signedHelperProtocolVersionKey];
  return {
    protocolVersion:
      typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0
        ? declared
        : null,
    version: version.trim(),
  };
}

/**
 * Compares two `CFBundleVersion` strings as macOS orders them: a dot-separated
 * sequence of non-negative integers, shorter meaning the missing components
 * are zero. Anything that is not that compares as equal in its own position,
 * which keeps a malformed version from reading as newer than a real one.
 */
export function compareBundleVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = componentValue(leftParts[index]);
    const rightPart = componentValue(rightParts[index]);
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Whether a connect failed because nothing is listening yet. */
export function isSignedHelperSocketAbsent(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** Connects to a helper's socket; `created` sees the socket before it connects. */
export async function openSignedHelperSocket(
  socketPath: string,
  created: (socket: Socket) => void,
): Promise<Socket> {
  return new Promise<Socket>((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    created(socket);
    const onError = (error: unknown): void => {
      socket.removeListener("connect", onConnect);
      socket.destroy();
      rejectPromise(error);
    };
    const onConnect = (): void => {
      socket.removeListener("error", onError);
      socket.setNoDelay(true);
      resolvePromise(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

export async function destroySignedHelperSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolvePromise) => {
    socket.once("close", resolvePromise);
    socket.destroy();
  });
}

/**
 * Runs `<executable> --verify-peer` with the connected socket as inherited
 * descriptor 3, so the helper's native code checks the process on the other
 * end by its audit token. The executable must be the copy sealed inside this
 * app: the installed one lives where anything running as the user can write.
 */
export async function runSignedHelperPeerVerifier(
  identity: Pick<SignedHelperIdentity, "peerLabel">,
  executable: string,
  socket: Socket,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["--verify-peer"], {
      stdio: ["ignore", "ignore", "pipe", socket],
    });
    let diagnostic = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${identity.peerLabel} peer verification timed out.`));
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (diagnostic.length < maximumPeerVerifierErrorBytes) {
        diagnostic += chunk.slice(0, maximumPeerVerifierErrorBytes - diagnostic.length);
      }
    });
    let settled = false;
    const reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    };
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          diagnostic.trim() ||
            `${identity.peerLabel} peer verification exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`,
        ),
      );
    });
  });
}

export const defaultSignedHelperRun: SignedHelperProcess = async (file, arguments_) => {
  const { stderr, stdout } = await execFileAsync(file, [...arguments_], {
    maxBuffer: maximumProcessOutputBytes,
  });
  // `codesign` writes its description to stderr and its failures to stderr
  // too, so both streams are one answer here rather than two.
  return `${stdout}${stderr}`;
};

type ReleaseLifecycleLock = () => Promise<void>;

async function acquireLifecycleLock(
  options: SignedHelperLifecycleLockOptions,
): Promise<ReleaseLifecycleLock> {
  const now = options.now ?? Date.now;
  let pause = firstLockRetryMs;
  for (;;) {
    const release = await tryLifecycleLock(options);
    if (release) return release;
    const remaining = options.deadline.at - now();
    if (remaining <= 0) throw options.identity.lockBusy();
    await delay(Math.min(pause, remaining));
    pause = Math.min(pause * 2, longestLockRetryMs);
  }
}

async function tryLifecycleLock(
  options: SignedHelperLifecycleLockOptions,
): Promise<ReleaseLifecycleLock | null> {
  if (signedHelperLifecycleLockFlags === null) {
    throw new Error(options.identity.unsupportedPlatformMessage);
  }
  try {
    const handle = await open(options.lockPath, signedHelperLifecycleLockFlags, 0o600);
    return async () => await handle.close();
  } catch (error) {
    // darwin's EWOULDBLOCK is EAGAIN, and Node names it that.
    if (nodeErrorCode(error) === "EAGAIN") return null;
    throw error;
  }
}

function componentValue(part: string | undefined): number {
  if (part === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(part)) return 0;
  const value = Number(part);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function shouldKeepInstalled(input: {
  readonly bundled: SignedHelperBundleInfo;
  readonly bundledSignature: SignedHelperSignature;
  readonly current: SignedHelperBundleInfo;
  readonly currentSignature: SignedHelperSignature;
  readonly development: boolean;
}): boolean {
  // The protocol outranks the version. A build made between releases carries
  // the last release's version, so by version alone the released helper of
  // that version would look just as current, refuse its newer protocol, and be
  // kept on every retry. Protocols only grow, so the helper that declares the
  // newer one is the newer build, and every app sharing this path makes the
  // same choice.
  const protocolOrder = (input.current.protocolVersion ?? 0) - (input.bundled.protocolVersion ?? 0);
  if (protocolOrder !== 0) return protocolOrder > 0;
  const order = compareBundleVersions(input.current.version, input.bundled.version);
  if (order > 0) return true;
  if (order < 0) return false;
  // A release helper is replaced only by a strictly newer one: Stable and Beta
  // sign their own builds of the same version, so a different hash at an equal
  // version is the other channel's copy, valid and just as current. Replacing
  // it would make the two apps swap the helper on every launch. Development
  // builds share the package version, so there an equal version is replaced
  // when its code changed, or a rebuilt helper would hide behind stale bytes.
  return !input.development || input.currentSignature.cdHash === input.bundledSignature.cdHash;
}

function matchLine(value: string, pattern: RegExp): string | null {
  return pattern.exec(value)?.[1]?.trim() ?? null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
