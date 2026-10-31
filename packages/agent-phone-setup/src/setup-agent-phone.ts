import type { RunnerId } from "@opensteer/core";
import {
  AgentPhoneArtifactManifestSchema,
  AgentPhonePairingSchema,
  AgentPhoneSetupStatusSchema,
  agentPhoneAccessibilityService,
  agentPhoneMinSdk,
  agentPhonePackageName,
  agentPhonePairingExtra,
  agentPhoneSetupActions,
  agentPhoneSetupResultCodes,
  agentPhoneSetupReceiver,
  type AgentPhoneArtifactManifest,
  type AgentPhoneHostTarget,
  type AgentPhoneIssueCode,
  type AgentPhonePairing,
  type AgentPhoneSetupStatus,
} from "@opensteer/protocol";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { delay } from "@opensteer/shared/delay";
import { apkSignedOnlyBy } from "./apk-signing.js";
import type { AgentPhoneEnrollmentSlot, AgentPhoneEnrollments } from "./enrollments.js";

/* ------------------------------------------------------------------------- *
 * Ports
 * ------------------------------------------------------------------------- */

export interface AgentPhoneShellResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** The package manager's verdict on one install; `output` is its own words. */
export type AgentPhoneInstallResult =
  { readonly ok: true } | { readonly ok: false; readonly output: string };

/**
 * Everything setup does to a phone, over whichever ADB transport reached it:
 * WebUSB in browsers, direct USB or an existing local ADB server on Desktop.
 */
export interface AgentPhoneAdb {
  /** A system property, read the way every Android version answers it. */
  getProp(key: string): Promise<string>;
  /** Runs one command in the phone's shell; the port quotes every argument. */
  shell(argv: readonly string[]): Promise<AgentPhoneShellResult>;
  /** Streams an APK into `pm install -r -i com.opensteer.agentphone -S <size>`. */
  install(apk: Uint8Array): Promise<AgentPhoneInstallResult>;
  /** A file the shell user may read, or null when it is larger than `maxBytes`. */
  readFile(path: string, maxBytes: number): Promise<Uint8Array | null>;
}

/** A one-use enrollment and where the phone reaches the Host that minted it. */
export interface AgentPhoneEnrollment {
  readonly enrollmentId: string;
  readonly expiresAt: string;
  readonly pairing: AgentPhoneHostTarget;
  readonly token: string;
}

export type AgentPhoneMintResult =
  | { readonly kind: "minted"; readonly enrollment: AgentPhoneEnrollment }
  /** A Personal Deployment with remote access off has nowhere for a phone to arrive. */
  | { readonly kind: "remote-access-off" };

export type AgentPhoneTargetResult =
  | { readonly kind: "target"; readonly target: AgentPhoneHostTarget }
  /** A Personal Deployment with remote access off has nowhere for a phone to arrive. */
  | { readonly kind: "remote-access-off" };

/** The owner's own session with the Deployment the phone joins. */
export interface AgentPhoneSetupHostPort {
  /**
   * `runner.enrollment.createPhone`. The Host answers one key with one
   * enrollment, however often it is asked.
   */
  mintEnrollment(input: {
    readonly idempotencyKey: string;
    readonly name: string;
  }): Promise<AgentPhoneMintResult>;
  /**
   * `runner.enrollment.retire`: makes the owner's enrollment unusable at once,
   * or says why it already was. Whichever it answers, no phone can redeem the
   * enrollment afterwards.
   */
  retireEnrollment(input: {
    readonly enrollmentId: string;
  }): Promise<"consumed" | "expired" | "retired">;
  /**
   * `agentPhone.target.get`: the Deployment, where a phone reaches it now, and
   * its name. An enrolled phone holding another address — a Personal route
   * that moved between Connect and a private route — or an older name is
   * brought up to date without minting.
   */
  pairingTarget(): Promise<AgentPhoneTargetResult>;
  /** Whether the phone's `android-phone` connection exists at any access. */
  phoneConnected(input: { readonly runnerId: RunnerId }): Promise<boolean>;
  /** The owner's `integration.computer.setup.set` for initial read-write access. */
  setInitialAccess(input: { readonly runnerId: RunnerId }): Promise<void>;
}

/** The build's APK and the manifest written beside it, both still unverified. */
export interface AgentPhoneArtifact {
  readonly bytes: Uint8Array;
  readonly manifest: unknown;
}

/* ------------------------------------------------------------------------- *
 * Progress and outcome
 * ------------------------------------------------------------------------- */

export interface AgentPhoneFacts {
  readonly manufacturer: string;
  readonly model: string;
  /** The Android version people know, such as "14". */
  readonly release: string;
  readonly sdk: number;
  /**
   * Whether a PIN, pattern or password locks the phone; null when Android did
   * not say. After a restart, its owner must unlock it once to reconnect.
   */
  readonly secureLock: boolean | null;
}

/**
 * Where setup is, emitted as each step begins. A step may be emitted again as
 * what it knows changes: `inspect` once the phone is read.
 */
export type AgentPhoneSetupStep =
  | { readonly phone: AgentPhoneFacts | null; readonly step: "inspect" }
  | { readonly step: "install" }
  | { readonly step: "configure" }
  | { readonly step: "pair" }
  | { readonly step: "done" };

/**
 * Why setup stopped. The phone's own pairing issues pass through by their
 * codes, so the person reads the same reason the phone shows.
 */
type AgentPhoneSetupIssueCode =
  | AgentPhoneIssueCode
  | "accessibility-failed"
  | "android-too-old"
  | "artifact-invalid"
  | "configure-failed"
  | "install-failed"
  | "paired-elsewhere"
  | "pairing-timed-out"
  | "phone-app-refused"
  | "phone-app-unresponsive"
  | "signature-mismatch";

export interface AgentPhoneSetupIssue {
  readonly code: AgentPhoneSetupIssueCode;
  /** The fact behind the code, in the phone's or Android's own words where it has them. */
  readonly detail: string | null;
}

export type AgentPhoneSetupResult =
  | { readonly outcome: "done"; readonly runnerId: RunnerId }
  | {
      readonly issue: AgentPhoneSetupIssue;
      readonly outcome: "issue";
      /** The phone's computer, once the Host has it. */
      readonly runnerId: RunnerId | null;
    };

interface SetupAgentPhoneOptions {
  readonly adb: AgentPhoneAdb;
  readonly artifact: AgentPhoneArtifact;
  /**
   * Asked before removing a build of the app signed by somebody else. Android
   * will not update it in place, and removing it erases that app's data.
   */
  readonly confirmUninstall: () => Promise<boolean>;
  /** Asked before unpairing a phone that already works for another Opensteer. */
  readonly confirmUnpair: (pairedTo: { readonly hostUrl: string }) => Promise<boolean>;
  /** The enrollments of the dialog this run belongs to, kept across its runs. */
  readonly enrollments: AgentPhoneEnrollments;
  readonly host: AgentPhoneSetupHostPort;
  readonly onStep: (step: AgentPhoneSetupStep) => void;
  readonly runnerName: string;
  readonly signal: AbortSignal;
}

/* ------------------------------------------------------------------------- *
 * The engine
 * ------------------------------------------------------------------------- */

const statusPollMs = 1_000;
const statusAnswerTimeoutMs = 10_000;
const accessibilityBindTimeoutMs = 20_000;
const unpairTimeoutMs = 15_000;
/** Discovery, enrollment and the first connection, over whatever network the phone has. */
const pairTimeoutMs = 120_000;
const reconnectTimeoutMs = 60_000;
/**
 * Enrollments one run sends before giving up. Each has its whole lifetime
 * ahead of a run's wait, so only a phone or Host that keeps refusing fresh
 * ones — not a slow phone — reaches this.
 */
const maxEnrollmentAttempts = 3;
const accessibilityServicesKey = "enabled_accessibility_services";
/** Bounds reading an installed APK that may not be ours at all. */
const maxInstalledApkBytes = 64 * 1_024 * 1_024;

/**
 * Makes the phone on the other end of `adb` an Opensteer Computer of the
 * Deployment `host` speaks for, or says exactly why it could not.
 *
 * Every step reads the phone before changing it, so running setup again — on
 * a phone that was unplugged halfway, or one already finished — continues
 * from where the phone is rather than repeating what it already did. Nothing
 * is minted before the app is installed, verified and running, and nothing is
 * minted at all while an earlier enrollment may still have succeeded.
 */
export async function setupAgentPhone(
  options: SetupAgentPhoneOptions,
): Promise<AgentPhoneSetupResult> {
  const setup = new PhoneSetup(options);
  try {
    return await setup.run();
  } catch (error) {
    if (error instanceof SetupStopped) {
      return { issue: error.issue, outcome: "issue", runnerId: error.runnerId };
    }
    throw error;
  }
}

class SetupStopped extends Error {
  readonly issue: AgentPhoneSetupIssue;
  readonly runnerId: RunnerId | null;

  constructor(code: AgentPhoneSetupIssueCode, detail: string | null, runnerId: RunnerId | null) {
    super(detail ?? code);
    this.issue = { code, detail };
    this.runnerId = runnerId;
  }
}

function stop(
  code: AgentPhoneSetupIssueCode,
  detail: string | null = null,
  runnerId: RunnerId | null = null,
): never {
  throw new SetupStopped(code, detail, runnerId);
}

/**
 * The phone's reasons that mean its enrollment can never be redeemed. Any
 * other reason, such as a Host it cannot reach yet, may still clear by itself.
 */
const deadEnrollmentIssues: ReadonlySet<AgentPhoneSetupIssueCode> = new Set([
  "enrollment-expired",
  "enrollment-refused",
]);

/** Connection states of a phone whose identity the Host has already admitted. */
const enrolledConnections: ReadonlySet<AgentPhoneSetupStatus["connection"]> = new Set([
  "connecting",
  "online",
  "offline",
  "needs-update",
]);

type PhonePairing = NonNullable<AgentPhoneSetupStatus["pairing"]>;

/** The two commands that carry a payload, as their refusals name them. */
const payloadCommands = {
  [agentPhoneSetupActions.pair]: { command: "the pairing", payload: "the pairing" },
  [agentPhoneSetupActions.retarget]: { command: "the move", payload: "its new address" },
} as const;

class PhoneSetup {
  readonly #adb: AgentPhoneAdb;
  readonly #artifact: AgentPhoneArtifact;
  readonly #options: SetupAgentPhoneOptions;
  readonly #host: AgentPhoneSetupHostPort;
  readonly #signal: AbortSignal;
  #runnerName: string;

  constructor(options: SetupAgentPhoneOptions) {
    this.#adb = options.adb;
    this.#artifact = options.artifact;
    this.#host = options.host;
    this.#options = options;
    this.#signal = options.signal;
    this.#runnerName = options.runnerName;
  }

  async run(): Promise<AgentPhoneSetupResult> {
    const manifest = await this.#verifyArtifact();
    const phone = await this.#inspect(manifest);
    await this.#install(manifest);
    await this.#configure(phone);
    const runnerId = await this.#pair();
    await this.#setInitialAccess(runnerId);
    this.#emit({ step: "done" });
    return { outcome: "done", runnerId };
  }

  #emit(step: AgentPhoneSetupStep): void {
    this.#signal.throwIfAborted();
    this.#options.onStep(step);
  }

  /**
   * Asks `check` once a second until it answers. Once `timeoutMs` has passed
   * without an answer, `onTimeout` stops setup with the reason.
   */
  async #poll<T>(
    timeoutMs: number,
    check: () => Promise<T | undefined>,
    onTimeout: () => never,
  ): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      const answer = await check();
      if (answer !== undefined) return answer;
      if (performance.now() >= deadline) onTimeout();
      await delay(statusPollMs, this.#signal);
    }
  }

  /* ---- Artifact ---------------------------------------------------------- */

  async #verifyArtifact(): Promise<AgentPhoneArtifactManifest> {
    const parsed = AgentPhoneArtifactManifestSchema.safeParse(this.#artifact.manifest);
    if (!parsed.success) stop("artifact-invalid", "The Agent Phone manifest is not valid.");
    const manifest = parsed.data;
    const { bytes } = this.#artifact;
    if (bytes.byteLength !== manifest.apkSize) {
      stop(
        "artifact-invalid",
        `The APK is ${bytes.byteLength} bytes; its manifest says ${manifest.apkSize}.`,
      );
    }
    if ((await sha256Hex(bytes)) !== manifest.apkSha256) {
      stop("artifact-invalid", "The APK's SHA-256 is not the one its manifest names.");
    }
    return manifest;
  }

  /* ---- Inspect ----------------------------------------------------------- */

  async #inspect(manifest: AgentPhoneArtifactManifest): Promise<AgentPhoneFacts> {
    this.#emit({ phone: null, step: "inspect" });
    const sdkText = (await this.#adb.getProp("ro.build.version.sdk")).trim();
    const release = (await this.#adb.getProp("ro.build.version.release")).trim();
    const manufacturer = (await this.#adb.getProp("ro.product.manufacturer")).trim();
    const model = (await this.#adb.getProp("ro.product.model")).trim();
    if (!/^[0-9]{1,3}$/u.test(sdkText)) {
      throw new Error(`The phone reported no Android API level (${JSON.stringify(sdkText)}).`);
    }
    const sdk = Number(sdkText);
    const required = Math.max(agentPhoneMinSdk, manifest.minSdk);
    if (sdk < required) {
      stop("android-too-old", `Android ${release} (API ${sdk}); needs API ${required}`);
    }
    const name = await this.#adb.shell(["settings", "get", "global", "device_name"]);
    if (name.exitCode !== 0) throw new Error("Android could not read the phone's device name.");
    const visibleName = name.stdout.trim();
    this.#runnerName =
      (visibleName && visibleName !== "null"
        ? visibleName
        : `${manufacturer} ${model}`.trim()
      ).slice(0, 120) || "Android phone";
    const lockSettings = await this.#adb.shell(["dumpsys", "lock_settings"]);
    const phone: AgentPhoneFacts = {
      manufacturer,
      model,
      release,
      sdk,
      secureLock: lockSettings.exitCode === 0 ? secureLockFrom(lockSettings.stdout) : null,
    };
    this.#emit({ phone, step: "inspect" });
    return phone;
  }

  /* ---- Install ----------------------------------------------------------- */

  async #install(manifest: AgentPhoneArtifactManifest): Promise<void> {
    this.#emit({ step: "install" });
    const installed = await this.#installedVersionCode();
    const current = installed !== null && installed >= manifest.versionCode;
    // A build at least as new as this one, signed by us, is kept: Android
    // would refuse the downgrade, and an equal build is already this one.
    if (current && (await this.#installedSignedBy(manifest))) {
      if (!(await this.#installerIsSelf())) {
        const bytes = await this.#installedApk();
        if (bytes === null)
          stop("install-failed", "The installed APK could not be read to retain its version.");
        const result = await this.#adb.install(bytes);
        if (!result.ok) stop("install-failed", result.output);
        if (!(await this.#installerIsSelf()))
          stop("configure-failed", "Android did not keep Agent Phone as its own installer.");
      }
      return;
    }
    // The installed build is not ours, so `pm` could only refuse to replace it.
    if (current) await this.#removeForeignBuild();
    let result = await this.#adb.install(this.#artifact.bytes);
    if (!result.ok && result.output.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")) {
      await this.#removeForeignBuild();
      result = await this.#adb.install(this.#artifact.bytes);
    }
    if (!result.ok) stop("install-failed", result.output);
    if (!(await this.#installedSignedBy(manifest))) {
      stop(
        "artifact-invalid",
        "The installed app is not signed by the certificate this Opensteer build names.",
      );
    }
    // Android 16 can discard an installer name that did not exist on the first install.
    // Replacing those same bytes now that the package exists records the installer without erasing data.
    if (!(await this.#installerIsSelf())) {
      const recorded = await this.#adb.install(this.#artifact.bytes);
      if (!recorded.ok) stop("install-failed", recorded.output);
      if (!(await this.#installerIsSelf()))
        stop("configure-failed", "Android did not keep Agent Phone as its own installer.");
    }
  }

  async #installerIsSelf(): Promise<boolean> {
    const listed = await this.#required(["pm", "list", "packages", "-i", agentPhonePackageName]);
    return listed.split("\n").some((line) => {
      const fields = line.trim().split(/\s+/u);
      return (
        fields[0] === `package:${agentPhonePackageName}` &&
        fields[1] === `installer=${agentPhonePackageName}`
      );
    });
  }

  async #installedVersionCode(): Promise<number | null> {
    const listed = await this.#required([
      "pm",
      "list",
      "packages",
      "--show-versioncode",
      agentPhonePackageName,
    ]);
    // `pm list packages` filters by substring, so the fixture app and any
    // other `com.opensteer.agentphone.*` package are listed too.
    for (const line of listed.split("\n")) {
      const match = /^package:(\S+) versionCode:([0-9]+)$/u.exec(line.trim());
      if (match?.[1] === agentPhonePackageName) return Number(match[2]);
    }
    return null;
  }

  async #installedApk(): Promise<Uint8Array | null> {
    const paths = await this.#adb.shell(["pm", "path", agentPhonePackageName]);
    const base = paths.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("package:") && line.endsWith("/base.apk"));
    if (paths.exitCode !== 0 || !base) return null;
    return this.#adb.readFile(base.slice("package:".length), maxInstalledApkBytes);
  }

  async #installedSignedBy(manifest: AgentPhoneArtifactManifest): Promise<boolean> {
    const bytes = await this.#installedApk();
    return (
      bytes !== null &&
      apkSignedOnlyBy(
        bytes,
        async (certificate) => (await sha256Hex(certificate)) === manifest.signingCertSha256,
      )
    );
  }

  async #removeForeignBuild(): Promise<void> {
    if (!(await this.#options.confirmUninstall())) stop("signature-mismatch");
    this.#signal.throwIfAborted();
    const removed = await this.#adb.shell(["pm", "uninstall", agentPhonePackageName]);
    if (removed.stdout.trim() !== "Success") {
      stop("install-failed", (removed.stdout || removed.stderr).trim());
    }
  }

  /* ---- Configure --------------------------------------------------------- */

  async #configure(phone: AgentPhoneFacts): Promise<void> {
    this.#emit({ step: "configure" });
    await this.#enableAccessibility();
    await this.#exemptFromBatteryOptimization();
    // Android 13 made notifications a runtime permission; older versions
    // reject the grant of a permission they do not have.
    if (phone.sdk >= 33) {
      await this.#configureCommand([
        "pm",
        "grant",
        agentPhonePackageName,
        "android.permission.POST_NOTIFICATIONS",
      ]);
    }
    // AppOps checks uid mode before package mode. Grant both so a previous
    // uid denial cannot override the package grant (AOSP AppOpsService.Shell).
    for (const target of [["--uid", agentPhonePackageName], [agentPhonePackageName]]) {
      await this.#configureCommand(["appops", "set", ...target, "PROJECT_MEDIA", "allow"]);
      await this.#configureCommand([
        "appops",
        "set",
        ...target,
        "REQUEST_INSTALL_PACKAGES",
        "allow",
      ]);
    }
    let projectionAllowed = false;
    let updatesAllowed = false;
    // Android's accessibility manager persists its own copy of the enabled
    // list while it handles the app installed a moment ago, and that copy can
    // predate setup's write. So the setting is not trusted from one read: it
    // is written again, keeping every other service, until it holds and the
    // service is bound — and only a setting that never holds is a failure.
    let last: AgentPhoneSetupStatus | null = null;
    let held = true;
    await this.#poll(
      accessibilityBindTimeoutMs,
      async () => {
        if (!held) await this.#enableAccessibility();
        // Android can answer the app installed a moment ago as an unknown
        // package, exiting 0; the exemption is written until the app reports it.
        if (last && !last.batteryOptimizationExempt) await this.#exemptFromBatteryOptimization();
        const status = await this.#readStatus();
        if (status) last = status;
        held = await this.#accessibilityHeld();
        const projection = await this.#configureCommand([
          "appops",
          "get",
          agentPhonePackageName,
          "PROJECT_MEDIA",
        ]);
        // AOSP's get prints "Uid mode: " on uid entries and usage metadata
        // after the mode. Missing uid entries mean the package mode applies.
        const modes = [...projection.matchAll(/^\s*(?:Uid mode: )?PROJECT_MEDIA:\s*(\w+)/gm)];
        projectionAllowed = modes.length > 0 && modes.every((match) => match[1] === "allow");

        const updates = await this.#configureCommand([
          "appops",
          "get",
          agentPhonePackageName,
          "REQUEST_INSTALL_PACKAGES",
        ]);
        const updateModes = [
          ...updates.matchAll(/^\s*(?:Uid mode: )?REQUEST_INSTALL_PACKAGES:\s*(\w+)/gm),
        ];
        updatesAllowed =
          updateModes.length > 0 && updateModes.every((match) => match[1] === "allow");
        return held &&
          updatesAllowed &&
          projectionAllowed &&
          status?.accessibility.connected &&
          status.batteryOptimizationExempt
          ? true
          : undefined;
      },
      () => {
        if (last === null) stop("phone-app-unresponsive", "The app did not answer setup.");
        if (!held) stop("accessibility-failed", "Android did not keep the accessibility setting.");
        if (!last.accessibility.connected) {
          stop("accessibility-failed", "Android has not started the app's accessibility service.");
        }
        if (!updatesAllowed) stop("configure-failed", "Android did not allow Agent Phone updates.");
        if (!projectionAllowed)
          stop("configure-failed", "Android did not allow screen projection.");
        stop("configure-failed", "Android did not exempt the app from battery optimization.");
      },
    );
  }

  async #exemptFromBatteryOptimization(): Promise<void> {
    await this.#configureCommand([
      "dumpsys",
      "deviceidle",
      "whitelist",
      `+${agentPhonePackageName}`,
    ]);
  }

  /** Lists our service among the enabled ones, keeping every other, and turns accessibility on. */
  async #enableAccessibility(): Promise<void> {
    const enabled = enabledServices(await this.#secureSetting(accessibilityServicesKey));
    if (!enabled.some(isAgentPhoneService)) {
      // Every other enabled service stays: the setting is the whole list, and
      // writing only ours would switch off whatever else the person relies on.
      await this.#putSecureSetting(
        accessibilityServicesKey,
        [...enabled, agentPhoneAccessibilityService].join(":"),
      );
    }
    if ((await this.#secureSetting("accessibility_enabled")) !== "1") {
      await this.#putSecureSetting("accessibility_enabled", "1");
    }
  }

  /** Whether Android's settings now list our service and have accessibility on. */
  async #accessibilityHeld(): Promise<boolean> {
    return (
      enabledServices(await this.#secureSetting(accessibilityServicesKey)).some(
        isAgentPhoneService,
      ) && (await this.#secureSetting("accessibility_enabled")) === "1"
    );
  }

  async #secureSetting(key: string): Promise<string> {
    return (await this.#required(["settings", "get", "secure", key])).trim();
  }

  async #putSecureSetting(key: string, value: string): Promise<void> {
    await this.#configureCommand(["settings", "put", "secure", key, value]);
  }

  async #configureCommand(argv: readonly string[]): Promise<string> {
    const result = await this.#adb.shell(argv);
    if (result.exitCode !== 0) {
      stop("configure-failed", `${argv.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout;
  }

  /* ---- Pair -------------------------------------------------------------- */

  async #pair(): Promise<RunnerId> {
    this.#emit({ step: "pair" });
    // Asked first: a Deployment with no route for a phone stops setup before
    // the phone is unpaired from anywhere or handed anything.
    const answer = await this.#host.pairingTarget();
    this.#signal.throwIfAborted();
    if (answer.kind === "remote-access-off") stop("remote-access-off");
    const { target } = answer;
    let status = await this.#requireStatus();
    if (status.pairing && status.pairing.deploymentId !== target.deploymentId) {
      status = await this.#unpairElsewhere(status.pairing.hostUrl);
    }
    const pairing = status.pairing;
    if (pairing && enrolledConnections.has(status.connection)) {
      return this.#reachTarget(status.connection, pairing, target);
    }
    if (pairing && (status.issue === null || !deadEnrollmentIssues.has(status.issue.code))) {
      // The phone holds a pairing with this Deployment from an earlier run.
      // Its enrollment may already have succeeded on the Host while the answer
      // was lost. The phone retries that same token itself; a second one now
      // could leave two computers for one phone. If the Host has moved since,
      // the phone takes the new address for the identity and token it holds.
      if (pairing.hostUrl !== target.hostUrl) {
        await this.#command(agentPhoneSetupActions.retarget, target, null);
      }
      const outcome = await this.#awaitEnrollment(pairing.enrollmentId, target.hostUrl);
      if (typeof outcome === "string") return outcome;
    }
    return this.#mintAndPair(pairing?.enrollmentId ?? null);
  }

  async #unpairElsewhere(hostUrl: string): Promise<AgentPhoneSetupStatus> {
    if (!(await this.#options.confirmUnpair({ hostUrl }))) stop("paired-elsewhere", hostUrl);
    await this.#broadcast(agentPhoneSetupActions.unpair);
    return this.#poll(
      unpairTimeoutMs,
      async () => {
        const status = await this.#readStatus();
        return status && status.pairing === null ? status : undefined;
      },
      () => stop("phone-app-unresponsive", "The phone did not leave its other Opensteer."),
    );
  }

  /** `spent` is an enrollment the phone holds and has reported dead. */
  async #mintAndPair(spent: string | null): Promise<RunnerId> {
    let dead = spent;
    for (let attempt = 1; ; attempt += 1) {
      const enrollment = await this.#enrollment(dead);
      await this.#command(
        agentPhoneSetupActions.pair,
        AgentPhonePairingSchema.parse({
          ...enrollment.pairing,
          enrollmentId: enrollment.enrollmentId,
          enrollmentToken: enrollment.token,
          expiresAt: enrollment.expiresAt,
          runnerName: this.#runnerName,
          version: 1,
        }),
        null,
      );
      const outcome = await this.#awaitEnrollment(
        enrollment.enrollmentId,
        enrollment.pairing.hostUrl,
      );
      if (typeof outcome === "string") return outcome;
      if (attempt === maxEnrollmentAttempts) stop(outcome.code, outcome.detail);
      dead = enrollment.enrollmentId;
    }
  }

  /**
   * The dialog's enrollment for this phone. The current slot's is sent again —
   * however little time it has left, and minted again under its own key when
   * that answer was lost — until the phone reports it dead or a different phone
   * needs one. Only once the Host has retired it, or says it was already
   * redeemed or expired, is the next slot opened, so the dialog never holds two
   * enrollments that could be redeemed.
   */
  async #enrollment(dead: string | null): Promise<AgentPhoneEnrollment> {
    const { enrollments } = this.#options;
    const runnerName = this.#runnerName;
    let slot = enrollments.current(runnerName);
    if (slot.name !== runnerName || (dead !== null && slot.enrollment?.enrollmentId === dead)) {
      const { enrollmentId } = await this.#minted(slot);
      await this.#host.retireEnrollment({ enrollmentId });
      this.#signal.throwIfAborted();
      slot = enrollments.next(slot, runnerName);
    }
    return this.#minted(slot);
  }

  /** The slot's enrollment, asked of the Host under the slot's own key until it answers. */
  async #minted(slot: AgentPhoneEnrollmentSlot): Promise<AgentPhoneEnrollment> {
    if (slot.enrollment !== null) return slot.enrollment;
    const minted = await this.#host.mintEnrollment({
      idempotencyKey: slot.idempotencyKey,
      name: slot.name,
    });
    this.#signal.throwIfAborted();
    if (minted.kind === "remote-access-off") stop("remote-access-off");
    slot.enrollment = minted.enrollment;
    return minted.enrollment;
  }

  /**
   * An enrolled phone of this Deployment works from the address the Host
   * gives now, under the name the Deployment has now. One already online
   * there with that name is left alone; any other is sent RETARGET, which the
   * phone takes only for its own enrolled identity, and setup waits for that
   * same runner online at that address with that name. A rename alone leaves
   * the phone's connection as it was.
   *
   * A phone at the right address that is not online is sent it too: if it
   * stopped because something else answered there, being told again is what
   * makes it look again, and an ordinary disconnect it ignores.
   */
  async #reachTarget(
    connection: AgentPhoneSetupStatus["connection"],
    pairing: PhonePairing,
    target: AgentPhoneHostTarget,
  ): Promise<RunnerId> {
    const atTarget = (current: PhonePairing) =>
      current.runnerId === pairing.runnerId &&
      current.hostUrl === target.hostUrl &&
      current.deploymentName === target.deploymentName;
    if (connection === "online" && atTarget(pairing)) return pairing.runnerId;
    await this.#command(agentPhoneSetupActions.retarget, target, pairing.runnerId);
    return this.#awaitOnline({
      matches: atTarget,
      runnerId: pairing.runnerId,
      timedOut: "The phone did not come back online at its new address.",
      timeoutMs: reconnectTimeoutMs,
    });
  }

  /**
   * Watches the phone redeem one enrollment at `hostUrl`: its runner once it
   * is online, or the phone's reason when the Host refused the token for good.
   */
  async #awaitEnrollment(
    enrollmentId: string,
    hostUrl: string,
  ): Promise<RunnerId | AgentPhoneSetupIssue> {
    try {
      return await this.#awaitOnline({
        matches: (pairing) => pairing.enrollmentId === enrollmentId && pairing.hostUrl === hostUrl,
        runnerId: null,
        timedOut: "The phone did not finish joining in time.",
        timeoutMs: pairTimeoutMs,
      });
    } catch (error) {
      if (error instanceof SetupStopped && deadEnrollmentIssues.has(error.issue.code)) {
        return error.issue;
      }
      throw error;
    }
  }

  /**
   * Waits for the phone to be online with the pairing `matches` picks out.
   * Its reasons count only while it reports that pairing, so an earlier
   * pairing's or the old address's trouble is never mistaken for this one's.
   */
  async #awaitOnline(wait: {
    readonly matches: (pairing: PhonePairing) => boolean;
    /** The computer a stop is reported against, once the Host has it. */
    readonly runnerId: RunnerId | null;
    readonly timedOut: string;
    readonly timeoutMs: number;
  }): Promise<RunnerId> {
    let issue: AgentPhoneSetupStatus["issue"] = null;
    return this.#poll(
      wait.timeoutMs,
      async () => {
        const status = await this.#readStatus();
        if (status?.connection === "removed") {
          stop("removed", status.issue?.detail ?? null, wait.runnerId);
        }
        if (!status?.pairing || !wait.matches(status.pairing)) return undefined;
        if (status.connection === "needs-update" && status.issue) {
          stop(status.issue.code, status.issue.detail, wait.runnerId);
        }
        if (status.connection === "online") return status.pairing.runnerId;
        issue = status.issue;
        if (issue && deadEnrollmentIssues.has(issue.code)) {
          stop(issue.code, issue.detail, wait.runnerId);
        }
        return undefined;
      },
      () => {
        if (issue) stop(issue.code, issue.detail, wait.runnerId);
        stop("pairing-timed-out", wait.timedOut, wait.runnerId);
      },
    );
  }

  /* ---- Initial access ---------------------------------------------------- */

  async #setInitialAccess(runnerId: RunnerId): Promise<void> {
    // Preserve the owner's current access, including a lowered read connection.
    if (await this.#host.phoneConnected({ runnerId })) return;
    await this.#host.setInitialAccess({ runnerId });
  }

  /* ---- The app's receiver ------------------------------------------------ */

  /**
   * Sends PAIR or RETARGET with its payload. The phone says at once whether
   * it took it; waiting on its status for one it refused would only end in a
   * timeout that names nothing.
   */
  async #command(
    action: keyof typeof payloadCommands,
    payload: AgentPhonePairing | AgentPhoneHostTarget,
    runnerId: RunnerId | null,
  ): Promise<void> {
    const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const code = resultCode(
      await this.#broadcast(action, ["--es", agentPhonePairingExtra, encoded]),
    );
    const named = payloadCommands[action];
    switch (code) {
      case agentPhoneSetupResultCodes.applied:
        return;
      case agentPhoneSetupResultCodes.alreadyPaired:
        return stop("paired-elsewhere");
      case agentPhoneSetupResultCodes.notEnrolled:
        return stop(
          "phone-app-refused",
          "The Agent Phone app on the phone has no enrollment to move.",
          runnerId,
        );
      case agentPhoneSetupResultCodes.invalidPayload:
        return stop(
          "phone-app-refused",
          `The Agent Phone app on the phone could not read ${named.payload}.`,
          runnerId,
        );
      default:
        return stop(
          "phone-app-refused",
          `The Agent Phone app answered ${named.command} with ${code}.`,
          runnerId,
        );
    }
  }

  async #broadcast(action: string, extras: readonly string[] = []): Promise<string> {
    const result = await this.#adb.shell([
      "am",
      "broadcast",
      // Until its accessibility service first binds, a fresh install is in the
      // stopped state, which ordinary broadcasts skip.
      "--include-stopped-packages",
      "-n",
      agentPhoneSetupReceiver,
      "-a",
      action,
      ...extras,
    ]);
    const completed = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("Broadcast completed: result="));
    if (result.exitCode !== 0 || completed === undefined) {
      stop("phone-app-unresponsive", (result.stderr || result.stdout).trim() || null);
    }
    return completed;
  }

  async #readStatus(): Promise<AgentPhoneSetupStatus | null> {
    const completed = await this.#broadcast(agentPhoneSetupActions.status);
    // `am` prints the result data between quotes without escaping it, so the
    // JSON runs to the line's last quote.
    const data = /^Broadcast completed: result=-?[0-9]+, data="(.*)"$/u.exec(completed)?.[1];
    if (data === undefined) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      return null;
    }
    const parsed = AgentPhoneSetupStatusSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  }

  async #requireStatus(): Promise<AgentPhoneSetupStatus> {
    return this.#poll(
      statusAnswerTimeoutMs,
      async () => (await this.#readStatus()) ?? undefined,
      () => stop("phone-app-unresponsive", "The app did not answer setup."),
    );
  }

  async #required(argv: readonly string[]): Promise<string> {
    const result = await this.#adb.shell(argv);
    if (result.exitCode !== 0) {
      throw new Error(`${argv.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout;
  }
}

/* ------------------------------------------------------------------------- *
 * What Android prints
 * ------------------------------------------------------------------------- */

/** The receiver's answer to a command, from the line `am broadcast` prints. */
function resultCode(completed: string): number {
  return Number(/^Broadcast completed: result=(-?[0-9]+)/u.exec(completed)?.[1]);
}

function enabledServices(value: string): string[] {
  // Android reads an unset secure setting back as the word "null".
  return value === "null" ? [] : value.split(":").filter((entry) => entry.length > 0);
}

/** Our service, spelled in full or in the short form Settings may store. */
function isAgentPhoneService(entry: string): boolean {
  const shortPrefix = `${agentPhonePackageName}/.`;
  const full = entry.startsWith(shortPrefix)
    ? `${agentPhonePackageName}/${agentPhonePackageName}.${entry.slice(shortPrefix.length)}`
    : entry;
  return full === agentPhoneAccessibilityService;
}

/**
 * The current user's credential type from `dumpsys lock_settings`. Some
 * releases print its number (-1 is none); Android 11 to 13 print its name as
 * `None` or `Pin`, and Android 16 as `NONE` or `PASSWORD_OR_PIN`.
 */
function secureLockFrom(dump: string): boolean | null {
  const value = /^\s*CredentialType:\s*(\S+)\s*$/mu.exec(dump)?.[1];
  if (value === undefined) return null;
  const name = value.toLowerCase().replaceAll("_", "");
  if (name === "none" || name === "-1") return false;
  return /^(?:[0-9]+|pattern|pin|password|passwordorpin)$/u.test(name) ? true : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Web Crypto takes only bytes backed by an ordinary ArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
