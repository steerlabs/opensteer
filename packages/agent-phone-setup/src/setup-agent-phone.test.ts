/**
 * The setup engine's decisions, against a phone and a Host that only answer.
 *
 * Failure modes, written before the engine:
 *
 * APK signer certificates (the bytes Android verified at install)
 * - Bytes that are not a ZIP, or a ZIP with no APK Signing Block, name no signer.
 * - A signing block whose header and footer sizes disagree is not trusted.
 * - A length that runs past its container (pair, signer, certificate list) is not trusted.
 * - Every v2, v3 and v3.1 signer's first certificate is reported with its scheme, so
 *   a block that names our certificate cannot hide a different signer in another.
 *
 * Whether the phone verified our signer
 * - A block the phone never verified vouches for the app on its own: a v3.1 block,
 *   which Android 11 and 12 ignore, or nothing at all in a v1-only APK, whose v1
 *   signer setup does not read. Android installs such an app under its real signer.
 * - A block naming our certificate stands beside one naming somebody else's — v2
 *   and v3 either way round, or a foreign v3.1 — and the one the phone verified is
 *   the foreign one.
 * - Flattening every block's certificates into one list lets a v3.1 block alone
 *   satisfy a check meant for the scheme the phone verified.
 * - Our own release, signed with v2 alone, or with v2, v3 and v3.1, is refused.
 *
 * Setup decisions
 * - Android older than 11, or older than the build's own minimum, is refused by name
 *   before anything is installed or minted.
 * - An APK whose bytes or size disagree with its manifest is never installed.
 * - A secure lock is reported as a warning; setup still finishes.
 * - A build signed by someone else is uninstalled only after the person confirms;
 *   declining stops with nothing written. A same-version foreign build counts too.
 * - The package manager's exact refusal is surfaced; nothing after install runs.
 * - The installed signer is checked before accessibility is enabled or a token sent.
 * - Our service is appended to the enabled list, never replacing others; the setting
 *   is read back, and the service must actually bind. Android's accessibility manager
 *   can persist its own stale copy of the list while it handles the app just installed,
 *   erasing an entry written a moment before: setup writes it again, still keeping
 *   others, until it holds — and only a setting that never holds is a failure.
 * - POST_NOTIFICATIONS is granted only on Android 13 and newer.
 * - A Host with no route for a phone (a Personal Deployment with remote access off)
 *   stops setup before anything is minted, unpaired or sent.
 * - An enrollment that expired before the phone used it is replaced.
 * - The phone's own reason for not reaching this Host is surfaced.
 * - A run resumed on a phone already pairing or paired here never mints again,
 *   and a pairing that may have succeeded is waited on rather than replaced.
 * - A phone still trying its enrollment at an address its Host no longer uses is
 *   waited on there, so every try times out; or it is handed a new enrollment,
 *   which could orphan a Runner the old one already made.
 * - An enrolled phone whose address is not the one this Deployment's Host gives now
 *   is moved there with RETARGET — never a PAIR, a mint or a new identity — and
 *   counts as done only once that same runner is online at the new address.
 *   One already online at that address is left alone. A refused RETARGET, a Host
 *   with remote access off, a phone that never comes back there, and another
 *   runner coming online are each reported, not mistaken for success.
 * - The phone learns the Deployment's name from its pairing. A Deployment renamed
 *   since reaches an enrolled phone through RETARGET when setup runs again, even
 *   one online at the right address, and moves nothing else; only that phone
 *   reporting the new name counts as done.
 * - A phone paired elsewhere is unpaired only after the person confirms.
 * - Only the enrollment this run sent counts as success.
 * - Fresh setup grants read-write only when no connection exists.
 * - A complete phone is a no-op: no install, no settings, no mint, no access change.
 * - Cancelling stops polling; an app that never answers STATUS is reported.
 *
 * One dialog's enrollments, across every run of setup in it ("Try again", or a
 * phone plugged back in), each run reaching the Host through a port built anew:
 * - Once every enrollment the dialog minted has expired, "Try again" gets those
 *   same expired enrollments back and stops, however often it is pressed.
 * - A restarted run mints a second enrollment while the dialog's last one could
 *   still be redeemed.
 * - An enrollment close to its expiry is replaced while the Host would still accept it.
 * - A mint whose answer was lost is asked again under a new key, minting a second
 *   enrollment, or under the old key with a different request, which the Host refuses.
 * - A different phone or name gets a new enrollment while the dialog's last one —
 *   or one whose mint answer was lost — could still be redeemed.
 * - Setup moves on because an enrollment is missing from a list of pending
 *   computers, which the Host cuts off at its newest hundred, while that
 *   enrollment can still be redeemed.
 * - An enrollment the phone already redeemed is handed to it again once the phone
 *   was removed, and the Host's refusal of it ends setup for good.
 * - The dialog's place in its sequence is lost when the Host port is built again.
 */
import { DeploymentIdSchema, HostInstanceIdSchema, RunnerIdSchema } from "@opensteer/core";
import {
  AgentPhoneHostTargetSchema,
  AgentPhonePairingSchema,
  agentPhoneAccessibilityService,
  agentPhonePackageName,
  agentPhonePairingExtra,
  agentPhoneSetupActions,
  agentPhoneSetupReceiver,
  type AgentPhoneArtifactManifest,
  type AgentPhoneHostTarget,
  type AgentPhoneIssueCode,
  type AgentPhonePairing,
  type AgentPhoneSetupStatus,
} from "@opensteer/protocol";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apkSignatureSchemes, apkSignedOnlyBy } from "./apk-signing.js";
import { AgentPhoneEnrollments } from "./enrollments.js";
import {
  setupAgentPhone,
  type AgentPhoneAdb,
  type AgentPhoneEnrollment,
  type AgentPhoneInstallResult,
  type AgentPhoneMintResult,
  type AgentPhoneSetupHostPort,
  type AgentPhoneSetupResult,
  type AgentPhoneSetupStep,
  type AgentPhoneShellResult,
  type AgentPhoneTargetResult,
} from "./setup-agent-phone.js";

/* ------------------------------------------------------------------------- *
 * Synthetic APKs: a ZIP tail carrying an APK Signing Block
 * ------------------------------------------------------------------------- */

const v2BlockId = 0x7109871a;
const v3BlockId = 0xf05368c0;
const v31BlockId = 0x1b93ad61;
const verityPaddingId = 0x42726577;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function prefixed(bytes: Uint8Array): Uint8Array {
  return concat(u32(bytes.length), bytes);
}

const text = (value: string) => new TextEncoder().encode(value);

interface SyntheticBlock {
  readonly id: number;
  /** Each signer's certificate chain, signing certificate first. */
  readonly signers?: readonly (readonly Uint8Array[])[];
  /** Raw pair value: padding, or a scheme value built by hand. */
  readonly value?: Uint8Array;
}

function signerValue(signers: readonly (readonly Uint8Array[])[]): Uint8Array {
  return prefixed(
    concat(
      ...signers.map((certificates) => {
        const signedData = concat(
          prefixed(new Uint8Array()),
          prefixed(concat(...certificates.map(prefixed))),
          prefixed(new Uint8Array()),
        );
        return prefixed(
          concat(prefixed(signedData), u32(30), u32(0x7fffffff), prefixed(new Uint8Array())),
        );
      }),
    ),
  );
}

/** The local file entries every synthetic APK starts with; its signing block follows. */
const entriesLength = 64;

function syntheticApk(
  blocks: readonly SyntheticBlock[] | null,
  options: { readonly footerSizeSkew?: number } = {},
): Uint8Array {
  const entries = concat(text("PK\u0003\u0004"), new Uint8Array(entriesLength - 4));
  const pairs = concat(
    ...(blocks ?? []).map((block) => {
      const value = block.value ?? signerValue(block.signers ?? []);
      return concat(u64(4 + value.length), u32(block.id), value);
    }),
  );
  const size = pairs.length + 8 + 16;
  const signingBlock =
    blocks === null
      ? new Uint8Array()
      : concat(
          u64(size),
          pairs,
          u64(size + (options.footerSizeSkew ?? 0)),
          text("APK Sig Block 42"),
        );
  const centralDirectory = concat(text("PK\u0001\u0002"), new Uint8Array(42));
  const centralDirectoryOffset = entries.length + signingBlock.length;
  const endOfCentralDirectory = concat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(centralDirectory.length),
    u32(centralDirectoryOffset),
    u16(0),
  );
  return concat(entries, signingBlock, centralDirectory, endOfCentralDirectory);
}

const ourCertificate = text("opensteer agent phone release certificate");
const foreignCertificate = text("somebody else's certificate");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("APK signer certificates", () => {
  it("finds no signer in bytes that are not a ZIP", () => {
    expect(apkSignatureSchemes(text("not an apk at all"))).toBeNull();
    expect(apkSignatureSchemes(new Uint8Array())).toBeNull();
  });

  it("finds no signer in a ZIP without an APK Signing Block", () => {
    expect(apkSignatureSchemes(syntheticApk(null))).toBeNull();
  });

  it("finds no signer in a signing block with no v2, v3 or v3.1 scheme", () => {
    expect(
      apkSignatureSchemes(syntheticApk([{ id: verityPaddingId, value: new Uint8Array(8) }])),
    ).toBeNull();
  });

  it("does not trust a signing block whose sizes disagree", () => {
    const apk = syntheticApk([{ id: v2BlockId, signers: [[ourCertificate]] }], {
      footerSizeSkew: 8,
    });
    expect(apkSignatureSchemes(apk)).toBeNull();
  });

  it("does not trust a pair whose length runs past the block", () => {
    const apk = syntheticApk([{ id: v2BlockId, signers: [[ourCertificate]] }]);
    // The first pair's length follows the block's own leading size.
    new DataView(apk.buffer).setBigUint64(entriesLength + 8, BigInt(apk.length), true);
    expect(apkSignatureSchemes(apk)).toBeNull();
  });

  it("does not trust a certificate list whose length runs past its signer", () => {
    const corrupt = concat(
      prefixed(
        prefixed(concat(prefixed(concat(prefixed(new Uint8Array()), u32(9_999), ourCertificate)))),
      ),
    );
    expect(apkSignatureSchemes(syntheticApk([{ id: v2BlockId, value: corrupt }]))).toBeNull();
  });

  it("reports every signer's signing certificate under the scheme that carried it", () => {
    const chainTail = text("an intermediate certificate");
    const apk = syntheticApk([
      { id: verityPaddingId, value: new Uint8Array(12) },
      { id: v2BlockId, signers: [[ourCertificate, chainTail]] },
      { id: v3BlockId, signers: [[foreignCertificate], [ourCertificate]] },
      { id: v31BlockId, signers: [[ourCertificate]] },
    ]);
    expect(apkSignatureSchemes(apk)).toEqual({
      v2: [ourCertificate],
      v3: [foreignCertificate, ourCertificate],
      "v3.1": [ourCertificate],
    });
  });
});

describe("whether the phone verified our signer", () => {
  const isOurs = async (certificate: Uint8Array) =>
    (await sha256Hex(certificate)) === (await sha256Hex(ourCertificate));
  const ours = (id: number): SyntheticBlock => ({ id, signers: [[ourCertificate]] });
  const foreign = (id: number): SyntheticBlock => ({ id, signers: [[foreignCertificate]] });

  it.each<[string, readonly SyntheticBlock[] | null]>([
    ["a v3.1 block alone, which Android 11 and 12 never verify", [ours(v31BlockId)]],
    ["a v1-only APK, whose signer setup cannot read", null],
    ["our v2 block beside a foreign v3 block", [ours(v2BlockId), foreign(v3BlockId)]],
    ["our v3 block beside a foreign v2 block", [foreign(v2BlockId), ours(v3BlockId)]],
    ["a foreign v3.1 block beside our v2 block", [ours(v2BlockId), foreign(v31BlockId)]],
    ["a foreign v3.1 block beside our v3 block", [ours(v3BlockId), foreign(v31BlockId)]],
    [
      "a v3 block that also carries a foreign signer",
      [ours(v2BlockId), { id: v3BlockId, signers: [[ourCertificate], [foreignCertificate]] }],
    ],
  ])("treats %s as foreign", async (_case, blocks) => {
    expect(await apkSignedOnlyBy(syntheticApk(blocks), isOurs)).toBe(false);
  });

  it.each<[string, readonly SyntheticBlock[]]>([
    ["v2 alone", [ours(v2BlockId)]],
    ["v2 and v3", [ours(v2BlockId), ours(v3BlockId)]],
    ["v2, v3 and v3.1", [ours(v2BlockId), ours(v3BlockId), ours(v31BlockId)]],
  ])("keeps %s naming our certificate", async (_case, blocks) => {
    expect(await apkSignedOnlyBy(syntheticApk(blocks), isOurs)).toBe(true);
  });

  it("treats the review's certificate-only v3.1 witness as foreign", async () => {
    // One signer whose signed data holds no digests and our certificate, and
    // nothing else: no signature and no public key, which nothing reads.
    const witness = syntheticApk([
      {
        id: v31BlockId,
        value: prefixed(
          prefixed(
            prefixed(concat(prefixed(new Uint8Array()), prefixed(prefixed(ourCertificate)))),
          ),
        ),
      },
    ]);
    expect(apkSignatureSchemes(witness)).toEqual({ "v3.1": [ourCertificate] });
    expect(await apkSignedOnlyBy(witness, isOurs)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * A phone and a Host that only answer
 * ------------------------------------------------------------------------- */

const deploymentId = DeploymentIdSchema.parse("dep_11111111-1111-4111-8111-111111111111");
const otherDeploymentId = DeploymentIdSchema.parse("dep_22222222-2222-4222-8222-222222222222");
const hostInstanceId = HostInstanceIdSchema.parse("hst_33333333-3333-4333-8333-333333333333");
const phoneRunnerId = RunnerIdSchema.parse("rnr_44444444-4444-4444-8444-444444444444");
const hostUrl = "https://opensteer.example.com";
const deploymentName = "Mac mini";
const shortServiceName = agentPhoneAccessibilityService.replace(`/${agentPhonePackageName}.`, "/.");
const installedApkPath = `/data/app/~~opaque==/${agentPhonePackageName}-other==/base.apk`;
/** The Host's own lifetime for a phone enrollment. */
const enrollmentLifetimeMs = 600_000;

let ourApk: Uint8Array;
let foreignApk: Uint8Array;
let manifest: AgentPhoneArtifactManifest;

beforeAll(async () => {
  ourApk = syntheticApk([{ id: v2BlockId, signers: [[ourCertificate]] }]);
  foreignApk = syntheticApk([{ id: v2BlockId, signers: [[foreignCertificate]] }]);
  manifest = {
    apkSha256: await sha256Hex(ourApk),
    apkSize: ourApk.length,
    buildType: "debug",
    minSdk: 30,
    packageName: agentPhonePackageName,
    signingCertSha256: await sha256Hex(ourCertificate),
    versionCode: 1_000_117,
    versionName: "0.1.117",
  };
});

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-11T12:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs time forward until `work` settles; setup only ever waits on its own timers. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const outcome = work.then(
    (value) => {
      done = true;
      return { value } as const;
    },
    (error: unknown) => {
      done = true;
      return { error } as const;
    },
  );
  while (!done) await vi.advanceTimersToNextTimerAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}

interface InstalledPackage {
  readonly apk: Uint8Array;
  readonly certificate: Uint8Array;
  readonly versionCode: number;
}

interface FakePhoneOptions {
  readonly sdk?: number;
  readonly release?: string;
  readonly credentialType?: string;
  readonly installed?: InstalledPackage | null;
  readonly enabledServices?: string;
  readonly accessibilityEnabled?: string;
  readonly batteryExempt?: boolean;
  readonly installFailure?: string;
  /** What reading the installed base.apk returns instead of the installed bytes. */
  readonly installedBytesOverride?: Uint8Array;
  readonly keepsAccessibilitySetting?: boolean;
  /**
   * The accessibility manager, handling the install, writes back the list it
   * held before setup's first write — once, just after that write.
   */
  readonly rewritesAccessibilityOnce?: boolean;
  /** Whitelist writes Android answers as an unknown package, as it can just after install. */
  readonly unknownWhitelistWrites?: number;
  readonly bindsAccessibility?: boolean;
  readonly answersStatus?: boolean;
  readonly pairing?: AgentPhoneSetupStatus["pairing"];
  readonly connection?: AgentPhoneSetupStatus["connection"];
  readonly issue?: AgentPhoneSetupStatus["issue"];
  /** The phone's answer to a PAIR, as its own enrollment would turn out. */
  readonly onPair?: (pairing: AgentPhonePairing, phone: FakePhone) => void;
  /**
   * The phone's answer to a RETARGET: the result code it answers, and what
   * becomes of its connection. By default an enrolled phone of that
   * Deployment takes the address and is online there when next asked.
   */
  readonly onRetarget?: (target: AgentPhoneHostTarget, phone: FakePhone) => number;
  /** Runs before each STATUS answer, for statuses that change while setup polls. */
  readonly beforeStatus?: (phone: FakePhone) => void;
}

/** The phone half: an Android shell with the Agent Phone app's receiver behind it. */
class FakePhone implements AgentPhoneAdb {
  deviceName = "Pixel 7";
  readonly commands: string[][] = [];
  readonly pairs: AgentPhonePairing[] = [];
  readonly retargets: AgentPhoneHostTarget[] = [];
  installs = 0;
  installed: InstalledPackage | null;
  /** Unplugged: every ADB command fails the way a closed USB connection does. */
  unplugged = false;
  readonly secure = new Map<string, string>();
  readonly whitelist = new Set<string>();
  readonly state: {
    connection: AgentPhoneSetupStatus["connection"];
    issue: AgentPhoneSetupStatus["issue"];
    pairing: AgentPhoneSetupStatus["pairing"];
  };
  readonly options: FakePhoneOptions;
  #rewroteAccessibility = false;
  #unknownWhitelistWrites = 0;

  constructor(options: FakePhoneOptions = {}) {
    this.options = options;
    this.installed = options.installed ?? null;
    if (options.enabledServices !== undefined) {
      this.secure.set("enabled_accessibility_services", options.enabledServices);
    }
    if (options.accessibilityEnabled !== undefined) {
      this.secure.set("accessibility_enabled", options.accessibilityEnabled);
    }
    if (options.batteryExempt) this.whitelist.add(agentPhonePackageName);
    this.state = {
      connection: options.connection ?? "unpaired",
      issue: options.issue ?? null,
      pairing: options.pairing ?? null,
    };
  }

  async getProp(key: string): Promise<string> {
    this.#plugged();
    this.commands.push(["getprop", key]);
    const props: Record<string, string> = {
      "ro.build.version.release": this.options.release ?? "14",
      "ro.build.version.sdk": String(this.options.sdk ?? 34),
      "ro.product.manufacturer": "Google",
      "ro.product.model": "Pixel 7",
    };
    return props[key] ?? "";
  }

  async install(apk: Uint8Array): Promise<AgentPhoneInstallResult> {
    this.#plugged();
    this.commands.push(["pm", "install", "-r", "-S", String(apk.length)]);
    this.installs += 1;
    if (this.options.installFailure) return { ok: false, output: this.options.installFailure };
    const certificate = apk === ourApk ? ourCertificate : foreignCertificate;
    if (this.installed && this.installed.certificate !== certificate) {
      return {
        ok: false,
        output: `Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package ${agentPhonePackageName} signatures do not match newer version; ignoring!]`,
      };
    }
    this.installed = { apk, certificate, versionCode: manifest.versionCode };
    return { ok: true };
  }

  async readFile(path: string, maxBytes: number): Promise<Uint8Array | null> {
    this.#plugged();
    this.commands.push(["read", path]);
    if (path !== installedApkPath || !this.installed) throw new Error(`No such file: ${path}`);
    const bytes = this.options.installedBytesOverride ?? this.installed.apk;
    return bytes.length > maxBytes ? null : bytes;
  }

  projectionAllowed = false;
  projectionUidAllowed = false;

  async shell(argv: readonly string[]): Promise<AgentPhoneShellResult> {
    this.#plugged();
    this.commands.push([...argv]);
    const command = argv.join(" ");
    const ok = (stdout = ""): AgentPhoneShellResult => ({ exitCode: 0, stderr: "", stdout });
    if (command === "settings get global device_name") return ok(this.deviceName + "\n");
    if (command === "dumpsys lock_settings") {
      return ok(
        `Current lock settings service state:\n\nUser State:\n  User 0\n    CredentialType: ${this.options.credentialType ?? "None"}\n    SeparateChallenge: false\n`,
      );
    }
    if (command === `pm list packages --show-versioncode ${agentPhonePackageName}`) {
      const lines = [`package:${agentPhonePackageName}.fixture versionCode:1`];
      if (this.installed) {
        lines.push(`package:${agentPhonePackageName} versionCode:${this.installed.versionCode}`);
      }
      return ok(`${lines.join("\n")}\n`);
    }
    if (command === `pm set-installer ${agentPhonePackageName} ${agentPhonePackageName}`)
      return ok();
    if (command === `pm list packages -i ${agentPhonePackageName}`)
      return ok(`package:${agentPhonePackageName} installer=${agentPhonePackageName}\n`);
    if (argv[0] === "appops" && argv.includes("REQUEST_INSTALL_PACKAGES"))
      return ok(argv[1] === "get" ? "REQUEST_INSTALL_PACKAGES: allow\n" : "");
    if (command === `pm path ${agentPhonePackageName}`) {
      return this.installed
        ? ok(`package:${installedApkPath}\n`)
        : { exitCode: 1, stderr: "", stdout: "" };
    }
    if (command === `pm uninstall ${agentPhonePackageName}`) {
      this.installed = null;
      this.state.pairing = null;
      this.state.connection = "unpaired";
      return ok("Success\n");
    }
    if (argv[0] === "settings" && argv[1] === "get" && argv[2] === "secure" && argv[3]) {
      return ok(`${this.secure.get(argv[3]) ?? "null"}\n`);
    }
    if (argv[0] === "settings" && argv[1] === "put" && argv[2] === "secure" && argv[3]) {
      const before = this.secure.get(argv[3]);
      if (this.options.keepsAccessibilitySetting !== false) {
        this.secure.set(argv[3], argv[4] ?? "");
      }
      if (
        argv[3] === "enabled_accessibility_services" &&
        this.options.rewritesAccessibilityOnce &&
        !this.#rewroteAccessibility
      ) {
        this.#rewroteAccessibility = true;
        if (before === undefined) this.secure.delete(argv[3]);
        else this.secure.set(argv[3], before);
      }
      return ok();
    }
    if (command === `dumpsys deviceidle whitelist +${agentPhonePackageName}`) {
      // DeviceIdleController answers an unknown package on stdout and exits 0.
      if (this.#unknownWhitelistWrites < (this.options.unknownWhitelistWrites ?? 0)) {
        this.#unknownWhitelistWrites += 1;
        return ok(`Unknown package: ${agentPhonePackageName}\n`);
      }
      this.whitelist.add(agentPhonePackageName);
      return ok(`Added: ${agentPhonePackageName}\n`);
    }
    if (command === `pm grant ${agentPhonePackageName} android.permission.POST_NOTIFICATIONS`) {
      return ok();
    }
    if (command === `appops set ${agentPhonePackageName} PROJECT_MEDIA allow`) {
      this.projectionAllowed = true;
      return ok();
    }
    if (command === `appops set --uid ${agentPhonePackageName} PROJECT_MEDIA allow`) {
      this.projectionUidAllowed = true;
      return ok("");
    }
    if (command === `appops get ${agentPhonePackageName} PROJECT_MEDIA`) {
      return ok(
        `Uid mode: PROJECT_MEDIA: ${this.projectionUidAllowed ? "allow" : "ignore"}\nPROJECT_MEDIA: ${this.projectionAllowed ? "allow" : "deny"}\n`,
      );
    }
    if (argv[0] === "am" && argv[1] === "broadcast") return ok(this.#broadcast(argv));
    return { exitCode: 127, stderr: `unexpected command: ${command}`, stdout: "" };
  }

  #plugged(): void {
    if (this.unplugged) throw new Error("The USB connection closed.");
  }

  #broadcast(argv: readonly string[]): string {
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(argv).toContain("--include-stopped-packages");
    expect(flag("-n")).toBe(agentPhoneSetupReceiver);
    const header = `Broadcasting: Intent { act=${flag("-a")} flg=0x400030 cmp=${agentPhoneSetupReceiver} (has extras) }\n`;
    if (!this.installed) return `${header}Broadcast completed: result=0\n`;
    switch (flag("-a")) {
      case agentPhoneSetupActions.status: {
        this.options.beforeStatus?.(this);
        if (this.options.answersStatus === false) return `${header}Broadcast completed: result=0\n`;
        return `${header}Broadcast completed: result=-1, data="${JSON.stringify(this.status())}"\n`;
      }
      case agentPhoneSetupActions.pair: {
        const payload = flag("--es") === agentPhonePairingExtra ? argv.at(-1) : undefined;
        const pairing = AgentPhonePairingSchema.parse(
          JSON.parse(new TextDecoder().decode(decodeBase64Url(payload ?? ""))),
        );
        this.pairs.push(pairing);
        this.state.pairing = {
          deploymentId: pairing.deploymentId,
          deploymentName: pairing.deploymentName,
          enrollmentId: pairing.enrollmentId,
          hostUrl: pairing.hostUrl,
          runnerId: phoneRunnerId,
        };
        this.state.connection = "pairing";
        this.state.issue = null;
        (this.options.onPair ?? onlineOnNextStatus)(pairing, this);
        return `${header}Broadcast completed: result=-1\n`;
      }
      case agentPhoneSetupActions.retarget: {
        const payload = flag("--es") === agentPhonePairingExtra ? argv.at(-1) : undefined;
        const target = AgentPhoneHostTargetSchema.parse(
          JSON.parse(new TextDecoder().decode(decodeBase64Url(payload ?? ""))),
        );
        this.retargets.push(target);
        const code = (this.options.onRetarget ?? movesItsIdentity)(target, this);
        return `${header}Broadcast completed: result=${code}\n`;
      }
      case agentPhoneSetupActions.unpair:
        this.state.pairing = null;
        this.state.connection = "unpaired";
        this.state.issue = null;
        return `${header}Broadcast completed: result=-1\n`;
      default:
        throw new Error(`unexpected action ${flag("-a")}`);
    }
  }

  status(): AgentPhoneSetupStatus {
    const services = (this.secure.get("enabled_accessibility_services") ?? "").split(":");
    const enabled = services.some(
      (service) => service === agentPhoneAccessibilityService || service === shortServiceName,
    );
    return {
      accessibility: {
        connected:
          enabled &&
          this.secure.get("accessibility_enabled") === "1" &&
          this.options.bindsAccessibility !== false,
        enabled,
      },
      app: { versionCode: this.installed?.versionCode ?? 1, versionName: "0.1.117" },
      batteryOptimizationExempt: this.whitelist.has(agentPhonePackageName),
      connection: this.state.connection,
      issue: this.state.issue,
      pairing: this.state.pairing,
      paused: false,
      version: 1,
    };
  }

  wrote(setting: string): boolean {
    return this.commands.some(
      (argv) => argv[0] === "settings" && argv[1] === "put" && argv[3] === setting,
    );
  }

  broadcasts(action: string): number {
    return this.commands.filter((argv) => argv[0] === "am" && argv.includes(action)).length;
  }
}

/**
 * The phone's own rule: only an identity of that Deployment moves, keeping its
 * runner, keys and token. An enrolled one is online there when next asked; a
 * pending one goes on trying its token at the new address.
 */
function movesItsIdentity(target: AgentPhoneHostTarget, phone: FakePhone): number {
  const pairing = phone.state.pairing;
  if (pairing === null) return 5;
  if (pairing.deploymentId !== target.deploymentId) return 2;
  phone.state.pairing = {
    ...pairing,
    deploymentName: target.deploymentName,
    hostUrl: target.hostUrl,
  };
  phone.state.issue = null;
  if (phone.state.connection !== "pairing") phone.state.connection = "online";
  return -1;
}

/** The usual outcome: the phone redeems the token and is online when next asked. */
function onlineOnNextStatus(_pairing: AgentPhonePairing, phone: FakePhone): void {
  phone.state.connection = "online";
}

function failsWith(code: AgentPhoneIssueCode, detail: string) {
  return (_pairing: AgentPhonePairing, phone: FakePhone) => {
    phone.state.issue = { code, detail };
  };
}

interface MintedEnrollment {
  readonly enrollment: AgentPhoneEnrollment;
  /** When it stops being redeemable; retiring it moves this to now. */
  expiresAt: number;
  readonly name: string;
  redeemed: boolean;
}

/**
 * The Host half: the owner's session and its connection changes.
 * Enrollments behave as the Host's do: one per idempotency key, refused for a
 * key sent with another request, redeemable until redeemed, retired or past
 * their own expiry.
 */
class FakeHost {
  /** Every mint and retirement asked for, in order. */
  readonly calls: string[] = [];
  /** Every mint asked for, in order, as the key and the name it was sent with. */
  readonly mints: { readonly idempotencyKey: string; readonly name: string }[] = [];
  readonly enrollments = new Map<string, MintedEnrollment>();
  readonly accessSets: string[] = [];
  readonly connected = new Set<string>();
  phone: FakePhone;
  remoteAccessOff = false;
  /** Makes the enrollment and then loses its answer, as a dropped connection would. */
  losesNextMintAnswer = false;
  /** Runs once a mint has been answered. */
  afterMint: (() => void) | null = null;
  /** Where the Host says a phone reaches it now. */
  target: AgentPhoneHostTarget = { deploymentId, deploymentName, hostInstanceId, hostUrl };
  targetReads = 0;

  constructor(phone: FakePhone) {
    this.phone = phone;
  }

  /** Every enrollment a phone could still redeem. */
  usable(): string[] {
    return [...this.enrollments.values()]
      .filter((minted) => !minted.redeemed && minted.expiresAt > Date.now())
      .map((minted) => minted.enrollment.enrollmentId);
  }

  /** Enrollments the same owner minted elsewhere, newer than any of this dialog's. */
  mintElsewhere(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const id = this.enrollments.size;
      this.enrollments.set(`elsewhere:${index}`, {
        enrollment: {
          enrollmentId: `ren_${id}`,
          expiresAt: new Date(Date.now() + enrollmentLifetimeMs).toISOString(),
          pairing: { deploymentId, deploymentName, hostInstanceId, hostUrl },
          token: `${"t".repeat(40)}${id}`,
        },
        expiresAt: Date.now() + enrollmentLifetimeMs,
        name: "Another phone",
        redeemed: false,
      });
    }
  }

  /** The phone presenting the token it holds, as the Host answers it. */
  redeem(phone: FakePhone): void {
    const pairing = phone.state.pairing;
    const minted = [...this.enrollments.values()].find(
      (candidate) => candidate.enrollment.enrollmentId === pairing?.enrollmentId,
    );
    if (!minted || minted.redeemed) {
      phone.state.issue = { code: "enrollment-refused", detail: "That code was already used." };
    } else if (minted.expiresAt <= Date.now()) {
      phone.state.issue = { code: "enrollment-expired", detail: "That code expired." };
    } else {
      minted.redeemed = true;
      phone.state.connection = "online";
      phone.state.issue = null;
    }
  }

  /** A port as one run of setup builds it; it keeps nothing of its own. */
  port(): AgentPhoneSetupHostPort {
    return {
      mintEnrollment: async (input) => this.#mint(input),
      pairingTarget: async (): Promise<AgentPhoneTargetResult> => {
        this.targetReads += 1;
        if (this.remoteAccessOff) return { kind: "remote-access-off" };
        return { kind: "target", target: this.target };
      },
      phoneConnected: async ({ runnerId }) => this.connected.has(runnerId),
      setInitialAccess: async ({ runnerId }) => {
        this.accessSets.push(runnerId);
        this.connected.add(runnerId);
      },
      retireEnrollment: async ({ enrollmentId }) => this.#retire(enrollmentId),
    };
  }

  #retire(enrollmentId: string): "consumed" | "expired" | "retired" {
    const minted = [...this.enrollments.values()].find(
      (candidate) => candidate.enrollment.enrollmentId === enrollmentId,
    );
    if (!minted) throw new Error("Runner enrollment not found");
    const state = minted.redeemed
      ? "consumed"
      : minted.expiresAt <= Date.now()
        ? "expired"
        : "retired";
    if (state === "retired") minted.expiresAt = Date.now();
    this.calls.push(`retire ${enrollmentId}: ${state}`);
    return state;
  }

  async #mint(input: {
    readonly idempotencyKey: string;
    readonly name: string;
  }): Promise<AgentPhoneMintResult> {
    this.mints.push({ ...input });
    this.calls.push(`mint ${input.idempotencyKey} ${input.name}`);
    if (this.remoteAccessOff) return { kind: "remote-access-off" };
    let minted = this.enrollments.get(input.idempotencyKey);
    if (minted && minted.name !== input.name) {
      throw new Error("Idempotency key is already bound to a different Runner enrollment request");
    }
    if (!minted) {
      const index = this.enrollments.size;
      minted = {
        enrollment: {
          enrollmentId: `ren_${index}`,
          expiresAt: new Date(Date.now() + enrollmentLifetimeMs).toISOString(),
          pairing: { deploymentId, deploymentName, hostInstanceId, hostUrl },
          token: `${"t".repeat(40)}${index}`,
        },
        expiresAt: Date.now() + enrollmentLifetimeMs,
        name: input.name,
        redeemed: false,
      };
      this.enrollments.set(input.idempotencyKey, minted);
    }
    if (this.losesNextMintAnswer) {
      this.losesNextMintAnswer = false;
      throw new Error("The connection to the Host closed.");
    }
    this.afterMint?.();
    return { enrollment: minted.enrollment, kind: "minted" };
  }
}

interface Run {
  readonly host: FakeHost;
  readonly phone: FakePhone;
  readonly result: AgentPhoneSetupResult;
  readonly steps: AgentPhoneSetupStep[];
  readonly uninstallAsked: number;
  readonly unpairAsked: readonly string[];
}

async function run(
  phoneOptions: FakePhoneOptions = {},
  setup: {
    readonly configureHost?: (host: FakeHost) => void;
    readonly confirmUninstall?: boolean;
    readonly confirmUnpair?: boolean;
    /** The dialog this run belongs to; a run of its own by default. */
    readonly dialog?: AgentPhoneEnrollments;
    /** A phone and Host that earlier runs already used. */
    readonly existing?: { readonly host: FakeHost; readonly phone: FakePhone };
    readonly manifest?: unknown;
    readonly bytes?: Uint8Array;
    readonly runnerName?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Run> {
  const phone = setup.existing?.phone ?? new FakePhone(phoneOptions);
  if (setup.runnerName !== undefined) phone.deviceName = setup.runnerName;
  const host = setup.existing?.host ?? new FakeHost(phone);
  setup.configureHost?.(host);
  const steps: AgentPhoneSetupStep[] = [];
  let uninstallAsked = 0;
  const unpairAsked: string[] = [];
  const result = await settled(
    setupAgentPhone({
      adb: phone,
      artifact: { bytes: setup.bytes ?? ourApk, manifest: setup.manifest ?? manifest },
      confirmUninstall: async () => {
        uninstallAsked += 1;
        return setup.confirmUninstall ?? false;
      },
      confirmUnpair: async ({ hostUrl: pairedTo }) => {
        unpairAsked.push(pairedTo);
        return setup.confirmUnpair ?? false;
      },
      enrollments: setup.dialog ?? new AgentPhoneEnrollments("dialog"),
      host: host.port(),
      onStep: (step) => steps.push(step),
      runnerName: setup.runnerName ?? "Pixel 7",
      signal: setup.signal ?? new AbortController().signal,
    }),
  );
  return { host, phone, result, steps, uninstallAsked, unpairAsked };
}

function issueOf(result: AgentPhoneSetupResult): string | null {
  return result.outcome === "issue" ? result.issue.code : null;
}

function keysOf(host: FakeHost): string[] {
  return host.mints.map(({ idempotencyKey }) => idempotencyKey);
}

/** A phone this Deployment already finished setting up. */
function completePhone(): FakePhoneOptions {
  return {
    accessibilityEnabled: "1",
    batteryExempt: true,
    connection: "online",
    enabledServices: shortServiceName,
    installed: { apk: ourApk, certificate: ourCertificate, versionCode: manifest.versionCode },
    pairing: {
      deploymentId,
      deploymentName,
      enrollmentId: "ren_earlier",
      hostUrl,
      runnerId: phoneRunnerId,
    },
  };
}

describe("setupAgentPhone", () => {
  it("refuses Android 10 before touching the phone or the Host", async () => {
    const { host, phone, result } = await run({ release: "10", sdk: 29 });
    expect(result).toEqual({
      issue: { code: "android-too-old", detail: "Android 10 (API 29); needs API 30" },
      outcome: "issue",
      runnerId: null,
    });
    expect(phone.installs).toBe(0);
    expect(phone.commands.every(([command]) => command === "getprop")).toBe(true);
    expect(host.mints).toEqual([]);
  });

  it("refuses a phone older than the build's own minimum", async () => {
    const { phone, result } = await run(
      { release: "12", sdk: 31 },
      { manifest: { ...manifest, minSdk: 33 } },
    );
    expect(issueOf(result)).toBe("android-too-old");
    expect(phone.installs).toBe(0);
  });

  it("never installs an APK whose bytes disagree with its manifest", async () => {
    const tampered = ourApk.slice();
    tampered[10] = 0xff;
    const mismatched = await run({}, { bytes: tampered });
    expect(issueOf(mismatched.result)).toBe("artifact-invalid");
    expect(mismatched.phone.installs).toBe(0);

    const wrongSize = await run({}, { manifest: { ...manifest, apkSize: manifest.apkSize + 1 } });
    expect(issueOf(wrongSize.result)).toBe("artifact-invalid");

    const notAManifest = await run({}, { manifest: { ...manifest, packageName: "com.other" } });
    expect(issueOf(notAManifest.result)).toBe("artifact-invalid");
    expect(notAManifest.host.mints).toEqual([]);
  });

  it("sets up a fresh phone end to end, warning about a secure lock", async () => {
    const otherService = "com.example.reader/.ReaderService";
    const { host, phone, result, steps } = await run({
      credentialType: "Pin",
      enabledServices: otherService,
    });

    expect(result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(steps.map(({ step }) => step)).toEqual([
      "inspect",
      "inspect",
      "install",
      "configure",
      "pair",
      "done",
    ]);
    expect(steps[1]).toEqual({
      phone: { manufacturer: "Google", model: "Pixel 7", release: "14", sdk: 34, secureLock: true },
      step: "inspect",
    });

    expect(phone.installs).toBe(1);
    expect(phone.secure.get("enabled_accessibility_services")).toBe(
      `${otherService}:${agentPhoneAccessibilityService}`,
    );
    expect(phone.secure.get("accessibility_enabled")).toBe("1");
    expect(phone.commands).toContainEqual([
      "pm",
      "grant",
      agentPhonePackageName,
      "android.permission.POST_NOTIFICATIONS",
    ]);
    expect(phone.pairs).toEqual([
      {
        deploymentId,
        deploymentName,
        enrollmentId: "ren_0",
        enrollmentToken: `${"t".repeat(40)}0`,
        expiresAt: expect.any(String),
        hostInstanceId,
        hostUrl,
        runnerName: "Pixel 7",
        version: 1,
      },
    ]);
    expect(host.mints).toEqual([{ idempotencyKey: "dialog:0", name: "Pixel 7" }]);
    expect(host.accessSets).toEqual([phoneRunnerId]);
    expect(host.connected.has(phoneRunnerId)).toBe(true);
  });

  it("checks the installed signer before enabling accessibility or sending a token", async () => {
    const order: string[] = [];
    const { phone, result } = await run({ installedBytesOverride: foreignApk });
    for (const argv of phone.commands) {
      if (argv[0] === "read") order.push("verify");
      if (argv[0] === "settings" && argv[1] === "put") order.push("configure");
    }
    expect(issueOf(result)).toBe("artifact-invalid");
    expect(order).toEqual(["verify"]);
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
  });

  it("grants and reads back projection permission even before Android 13", async () => {
    const { phone, result } = await run({ release: "12", sdk: 31 });
    expect(result.outcome).toBe("done");
    expect(phone.commands).toContainEqual([
      "appops",
      "set",
      agentPhonePackageName,
      "PROJECT_MEDIA",
      "allow",
    ]);
    expect(phone.commands).toContainEqual([
      "appops",
      "set",
      "--uid",
      agentPhonePackageName,
      "PROJECT_MEDIA",
      "allow",
    ]);
    expect(phone.commands).toContainEqual([
      "appops",
      "get",
      agentPhonePackageName,
      "PROJECT_MEDIA",
    ]);
  });

  it("polls projection readback until Android reports allow with usage metadata", async () => {
    const original = FakePhone.prototype.shell;
    let reads = 0;
    vi.spyOn(FakePhone.prototype, "shell").mockImplementation(async function (
      this: FakePhone,
      argv,
    ) {
      if (argv[0] === "appops" && argv[1] === "get" && argv[3] === "PROJECT_MEDIA") {
        reads += 1;
        return {
          exitCode: 0,
          stderr: "",
          stdout: reads < 3 ? "No operations.\n" : "PROJECT_MEDIA: allow; time=+3s ago\n",
        };
      }
      return original.call(this, argv);
    });
    const { result } = await run();
    expect(result.outcome).toBe("done");
    expect(reads).toBe(3);
  });
  it("stops before pairing when the projection grant command fails", async () => {
    const original = FakePhone.prototype.shell;
    vi.spyOn(FakePhone.prototype, "shell").mockImplementation(async function (
      this: FakePhone,
      argv,
    ) {
      if (argv[0] === "appops" && argv[1] === "set")
        return { exitCode: 1, stderr: "Permission denied", stdout: "" };
      return original.call(this, argv);
    });
    const { phone, result } = await run();
    expect(issueOf(result)).toBe("configure-failed");
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
  });
  it("refuses to pair when Android does not retain projection permission", async () => {
    const original = FakePhone.prototype.shell;
    const spy = vi.spyOn(FakePhone.prototype, "shell").mockImplementation(async function (
      this: FakePhone,
      argv,
    ) {
      if (argv[0] === "appops" && argv[1] === "get" && argv[3] === "PROJECT_MEDIA")
        return { exitCode: 0, stderr: "", stdout: "PROJECT_MEDIA: deny\n" };
      return original.call(this, argv);
    });
    try {
      const { phone, result } = await run();
      expect(issueOf(result)).toBe("configure-failed");
      expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // Projection failures: Android enforces a denied uid ahead of allowed package
  // mode; uid-only readback is valid; metadata is not part of the mode; command
  // failure must become a setup issue rather than an uncaught Error.
  it.each([
    ["Uid mode: PROJECT_MEDIA: ignore\nPROJECT_MEDIA: allow\n", "configure-failed"],
    ["Uid mode: PROJECT_MEDIA: allow\nPROJECT_MEDIA: ignore\n", "configure-failed"],
    ["Uid mode: PROJECT_MEDIA: allow\n", null],
    ["Uid mode: PROJECT_MEDIA: allow; time=+3s ago\n  PROJECT_MEDIA: allow (running)\n", null],
  ] as const)("checks both levels in AOSP projection readback %s", async (stdout, issue) => {
    const original = FakePhone.prototype.shell;
    vi.spyOn(FakePhone.prototype, "shell").mockImplementation(async function (
      this: FakePhone,
      argv,
    ) {
      if (argv[0] === "appops" && argv[1] === "get" && argv[3] === "PROJECT_MEDIA")
        return { exitCode: 0, stderr: "", stdout };
      return original.call(this, argv);
    });
    const { phone, result } = await run();
    if (issue) {
      expect(issueOf(result)).toBe(issue);
      expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    } else expect(result.outcome).toBe("done");
  });
  it("reports configure-failed when projection readback exits unsuccessfully", async () => {
    const original = FakePhone.prototype.shell;
    vi.spyOn(FakePhone.prototype, "shell").mockImplementation(async function (
      this: FakePhone,
      argv,
    ) {
      if (argv[0] === "appops" && argv[1] === "get" && argv[3] === "PROJECT_MEDIA")
        return { exitCode: 1, stderr: "Permission denied", stdout: "" };
      return original.call(this, argv);
    });
    const { phone, result } = await run();
    expect(issueOf(result)).toBe("configure-failed");
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
  });
  it("grants notifications only on Android 13 and newer", async () => {
    const { phone, result } = await run({ release: "12", sdk: 31 });
    expect(result.outcome).toBe("done");
    expect(phone.commands.some(([command, verb]) => command === "pm" && verb === "grant")).toBe(
      false,
    );
  });

  it("stops at a build signed by someone else unless the person uninstalls it", async () => {
    const installed = { apk: foreignApk, certificate: foreignCertificate, versionCode: 3 };
    const declined = await run({ installed }, { confirmUninstall: false });
    expect(declined.uninstallAsked).toBe(1);
    expect(issueOf(declined.result)).toBe("signature-mismatch");
    expect(declined.phone.commands.some((argv) => argv.includes("uninstall"))).toBe(false);
    expect(declined.phone.wrote("enabled_accessibility_services")).toBe(false);
    expect(declined.host.mints).toEqual([]);

    const confirmed = await run({ installed }, { confirmUninstall: true });
    expect(confirmed.result.outcome).toBe("done");
    expect(confirmed.phone.commands).toContainEqual(["pm", "uninstall", agentPhonePackageName]);
    expect(confirmed.phone.installs).toBe(2);
  });

  it("treats an installed build whose only v2 or v3 signer is missing as foreign", async () => {
    const forged = syntheticApk([{ id: v31BlockId, signers: [[ourCertificate]] }]);
    const { host, phone, result, uninstallAsked } = await run({
      installed: { apk: forged, certificate: foreignCertificate, versionCode: 1_000_117 },
    });
    expect(uninstallAsked).toBe(1);
    expect(issueOf(result)).toBe("signature-mismatch");
    expect(phone.wrote("enabled_accessibility_services")).toBe(false);
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    expect(host.mints).toEqual([]);
  });

  it("does not install over a same-version build signed by someone else", async () => {
    const { phone, result, uninstallAsked } = await run({
      installed: { apk: foreignApk, certificate: foreignCertificate, versionCode: 1_000_117 },
    });
    expect(uninstallAsked).toBe(1);
    expect(issueOf(result)).toBe("signature-mismatch");
    expect(phone.installs).toBe(0);
  });

  it("surfaces the package manager's exact refusal and goes no further", async () => {
    const output = "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]";
    const { host, phone, result } = await run({ installFailure: output });
    expect(result).toEqual({
      issue: { code: "install-failed", detail: output },
      outcome: "issue",
      runnerId: null,
    });
    expect(phone.wrote("enabled_accessibility_services")).toBe(false);
    expect(host.mints).toEqual([]);
  });

  it("exempts the app again when Android did not know it yet", async () => {
    const { phone, result } = await run({ unknownWhitelistWrites: 2 });
    expect(result.outcome).toBe("done");
    expect(
      phone.commands.filter(
        (argv) => argv.join(" ") === `dumpsys deviceidle whitelist +${agentPhonePackageName}`,
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("fails when Android never exempts the app from battery optimization", async () => {
    const { host, result } = await run({ unknownWhitelistWrites: Number.POSITIVE_INFINITY });
    expect(result).toMatchObject({
      issue: {
        code: "configure-failed",
        detail: "Android did not exempt the app from battery optimization.",
      },
    });
    expect(host.mints).toEqual([]);
  });

  it("keeps other accessibility services and fails when Android drops the setting", async () => {
    const others = "com.example.a/.A:com.example.b/com.example.b.B";
    const { host, phone, result } = await run({
      enabledServices: others,
      keepsAccessibilitySetting: false,
    });
    expect(phone.commands).toContainEqual([
      "settings",
      "put",
      "secure",
      "enabled_accessibility_services",
      `${others}:${agentPhoneAccessibilityService}`,
    ]);
    expect(result).toMatchObject({
      issue: {
        code: "accessibility-failed",
        detail: "Android did not keep the accessibility setting.",
      },
    });
    expect(host.mints).toEqual([]);
  });

  it("writes the service again when Android drops it while handling the install", async () => {
    const others = "com.example.a/.A";
    const { phone, result } = await run({
      enabledServices: others,
      rewritesAccessibilityOnce: true,
    });
    expect(result.outcome).toBe("done");
    expect(phone.secure.get("enabled_accessibility_services")).toBe(
      `${others}:${agentPhoneAccessibilityService}`,
    );
    expect(
      phone.commands.filter(
        (argv) => argv[1] === "put" && argv[3] === "enabled_accessibility_services",
      ),
    ).toEqual([
      [
        "settings",
        "put",
        "secure",
        "enabled_accessibility_services",
        `${others}:${agentPhoneAccessibilityService}`,
      ],
      [
        "settings",
        "put",
        "secure",
        "enabled_accessibility_services",
        `${others}:${agentPhoneAccessibilityService}`,
      ],
    ]);
  });

  it("fails when the accessibility service never binds", async () => {
    const { host, result } = await run({ bindsAccessibility: false });
    expect(issueOf(result)).toBe("accessibility-failed");
    expect(host.mints).toEqual([]);
  });

  it("stops before minting or pairing when the Host has no route for a phone", async () => {
    const { host, phone, result } = await run(
      {},
      {
        configureHost: (configured) => {
          configured.remoteAccessOff = true;
        },
      },
    );
    expect(result).toEqual({
      issue: { code: "remote-access-off", detail: null },
      outcome: "issue",
      runnerId: null,
    });
    expect(host.mints).toEqual([]);
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
  });

  it("replaces an enrollment that expired before the phone used it", async () => {
    const { host, phone, result } = await run({
      onPair: (pairing, configured) => {
        if (pairing.enrollmentId === "ren_0") {
          // The phone took longer than the enrollment's life to reach the Host.
          vi.setSystemTime(Date.now() + enrollmentLifetimeMs + 60_000);
          configured.state.issue = { code: "enrollment-expired", detail: "The code expired." };
        } else {
          configured.state.connection = "online";
        }
      },
    });
    expect(result.outcome).toBe("done");
    expect(keysOf(host)).toEqual(["dialog:0", "dialog:1"]);
    expect(phone.pairs.map(({ enrollmentId }) => enrollmentId)).toEqual(["ren_0", "ren_1"]);
  });

  it("surfaces the phone's own reason for not reaching this Host", async () => {
    const detail = "https://opensteer.example.com answered as a different Opensteer.";
    const { host, result } = await run({ onPair: failsWith("host-mismatch", detail) });
    expect(result).toEqual({
      issue: { code: "host-mismatch", detail },
      outcome: "issue",
      runnerId: null,
    });
    expect(keysOf(host)).toEqual(["dialog:0"]);
  });

  it("resumes a phone that is already pairing here without minting again", async () => {
    let polls = 0;
    const { host, phone, result } = await run({
      ...completePhone(),
      beforeStatus: (configured) => {
        polls += 1;
        if (polls > 3) configured.state.connection = "online";
      },
      connection: "pairing",
    });
    expect(result.outcome).toBe("done");
    expect(host.mints).toEqual([]);
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    expect(host.accessSets).toEqual([phoneRunnerId]);
  });

  it("waits on a pairing that may have succeeded rather than replacing it", async () => {
    const { host, phone, result } = await run({
      ...completePhone(),
      connection: "pairing",
      issue: { code: "host-unreachable", detail: "No route to opensteer.example.com" },
    });
    expect(result).toEqual({
      issue: { code: "host-unreachable", detail: "No route to opensteer.example.com" },
      outcome: "issue",
      runnerId: null,
    });
    expect(host.mints).toEqual([]);
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    expect(phone.retargets).toEqual([]);
  });

  it("moves a pending pairing to the address its Host gives now, keeping its enrollment", async () => {
    const moved = "https://mac.private.example";
    const before = completePhone();
    const { host, phone, result } = await run(
      {
        ...before,
        // At its new address the phone redeems the token it already holds.
        beforeStatus: (configured) => {
          if (configured.state.pairing?.hostUrl === moved) configured.state.connection = "online";
        },
        connection: "pairing",
        issue: { code: "host-unreachable", detail: `No route to ${hostUrl}` },
      },
      {
        configureHost: (configured) => {
          configured.target = { ...configured.target, hostUrl: moved };
        },
      },
    );
    expect(result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(phone.retargets).toEqual([
      { deploymentId, deploymentName, hostInstanceId, hostUrl: moved },
    ]);
    expect(phone.state.pairing).toEqual({ ...before.pairing, hostUrl: moved });
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    expect(host.calls).toEqual([]);
  });

  it("replaces a dead pairing found when setup resumes", async () => {
    const { host, result } = await run({
      ...completePhone(),
      connection: "pairing",
      issue: { code: "enrollment-refused", detail: "That code was withdrawn." },
    });
    expect(result.outcome).toBe("done");
    expect(keysOf(host)).toEqual(["dialog:0"]);
  });

  it("unpairs a phone paired elsewhere only after the person confirms", async () => {
    const elsewhere = {
      ...completePhone(),
      pairing: {
        deploymentId: otherDeploymentId,
        deploymentName: "Office server",
        enrollmentId: "ren_elsewhere",
        hostUrl: "https://other.example.com",
        runnerId: RunnerIdSchema.parse("rnr_55555555-5555-4555-8555-555555555555"),
      },
    };
    const declined = await run(elsewhere, { confirmUnpair: false });
    expect(declined.unpairAsked).toEqual(["https://other.example.com"]);
    expect(declined.result).toEqual({
      issue: { code: "paired-elsewhere", detail: "https://other.example.com" },
      outcome: "issue",
      runnerId: null,
    });
    expect(declined.phone.broadcasts(agentPhoneSetupActions.unpair)).toBe(0);
    expect(declined.host.mints).toEqual([]);

    const confirmed = await run(elsewhere, { confirmUnpair: true });
    expect(confirmed.phone.broadcasts(agentPhoneSetupActions.unpair)).toBe(1);
    expect(keysOf(confirmed.host)).toEqual(["dialog:0"]);
    expect(confirmed.result.outcome).toBe("done");
  });

  it("moves an enrolled phone to the address its Host gives now, keeping its runner", async () => {
    const moved = "https://mac.private.example";
    const { host, phone, result } = await run(completePhone(), {
      configureHost: (configured) => {
        configured.connected.add(phoneRunnerId);
        configured.target = { ...configured.target, hostUrl: moved };
      },
    });
    expect(result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(phone.retargets).toEqual([
      { deploymentId, deploymentName, hostInstanceId, hostUrl: moved },
    ]);
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    expect(phone.broadcasts(agentPhoneSetupActions.unpair)).toBe(0);
    expect(host.mints).toEqual([]);
    expect(phone.state.pairing).toMatchObject({ hostUrl: moved, runnerId: phoneRunnerId });
  });

  it("tells a fresh phone the Deployment's name in its pairing", async () => {
    const { phone, result } = await run();
    expect(result.outcome).toBe("done");
    expect(phone.pairs).toEqual([expect.objectContaining({ deploymentName, hostUrl })]);
    expect(phone.retargets).toEqual([]);
  });

  it("renames an enrolled phone online at its Host's address, moving nothing", async () => {
    const before = completePhone();
    const { host, phone, result } = await run(
      { ...before, pairing: { ...before.pairing!, deploymentName: "Alex's old Mac" } },
      {
        configureHost: (configured) => {
          configured.connected.add(phoneRunnerId);
        },
      },
    );
    expect(result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(phone.retargets).toEqual([{ deploymentId, deploymentName, hostInstanceId, hostUrl }]);
    expect(phone.state.pairing).toEqual({ ...before.pairing, deploymentName });
    expect(phone.broadcasts(agentPhoneSetupActions.pair)).toBe(0);
    expect(host.mints).toEqual([]);
  });

  it("does not count a phone that kept the old name as renamed", async () => {
    const before = completePhone();
    const { result } = await run(
      {
        ...before,
        onRetarget: () => -1,
        pairing: { ...before.pairing!, deploymentName: "Alex's old Mac" },
      },
      {
        configureHost: (configured) => {
          configured.connected.add(phoneRunnerId);
        },
      },
    );
    expect(result).toMatchObject({
      issue: { code: "pairing-timed-out" },
      outcome: "issue",
      runnerId: phoneRunnerId,
    });
  });

  it("asks a phone at its Host's address that is not online to try that address again", async () => {
    const { host, phone, result } = await run(
      {
        ...completePhone(),
        connection: "offline",
        issue: { code: "host-mismatch", detail: "Something else answered there." },
      },
      {
        configureHost: (configured) => {
          configured.connected.add(phoneRunnerId);
        },
      },
    );
    expect(result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(phone.retargets).toEqual([{ deploymentId, deploymentName, hostInstanceId, hostUrl }]);
    expect(host.mints).toEqual([]);
  });

  it("moves nothing while the Host has no route for a phone", async () => {
    const { host, phone, result } = await run(completePhone(), {
      configureHost: (configured) => {
        configured.remoteAccessOff = true;
      },
    });
    expect(result).toEqual({
      issue: { code: "remote-access-off", detail: null },
      outcome: "issue",
      runnerId: null,
    });
    expect(phone.retargets).toEqual([]);
    expect(host.mints).toEqual([]);
  });

  it("reports a RETARGET the phone refuses rather than waiting on it", async () => {
    const moved = (configured: FakeHost) => {
      configured.target = { ...configured.target, hostUrl: "https://mac.private.example" };
    };
    const elsewhere = await run(
      { ...completePhone(), onRetarget: () => 2 },
      { configureHost: moved },
    );
    expect(elsewhere.result).toEqual({
      issue: { code: "paired-elsewhere", detail: null },
      outcome: "issue",
      runnerId: null,
    });
    for (const code of [1, 5]) {
      const refused = await run(
        { ...completePhone(), onRetarget: () => code },
        { configureHost: moved },
      );
      expect(refused.result).toMatchObject({
        issue: { code: "phone-app-refused" },
        outcome: "issue",
        runnerId: phoneRunnerId,
      });
      expect(refused.host.mints).toEqual([]);
    }
  });

  it("reports the phone's own reason when it never comes back at the new address", async () => {
    const moved = "https://mac.private.example";
    const detail = `${moved} is not the Opensteer this phone was set up for.`;
    const { host, result } = await run(
      {
        ...completePhone(),
        onRetarget: (target, configured) => {
          configured.state.pairing = { ...configured.state.pairing!, hostUrl: target.hostUrl };
          configured.state.connection = "offline";
          configured.state.issue = { code: "host-mismatch", detail };
          return -1;
        },
      },
      {
        configureHost: (configured) => {
          configured.target = { ...configured.target, hostUrl: moved };
        },
      },
    );
    expect(result).toEqual({
      issue: { code: "host-mismatch", detail },
      outcome: "issue",
      runnerId: phoneRunnerId,
    });
    expect(host.mints).toEqual([]);
    expect(host.accessSets).toEqual([]);
  });

  it("does not count another runner online at the new address as the phone it moved", async () => {
    const { result } = await run(
      {
        ...completePhone(),
        onRetarget: (target, configured) => {
          configured.state.pairing = {
            ...configured.state.pairing!,
            hostUrl: target.hostUrl,
            runnerId: RunnerIdSchema.parse("rnr_66666666-6666-4666-8666-666666666666"),
          };
          configured.state.connection = "online";
          return -1;
        },
      },
      {
        configureHost: (configured) => {
          configured.target = { ...configured.target, hostUrl: "https://mac.private.example" };
        },
      },
    );
    expect(issueOf(result)).toBe("pairing-timed-out");
  });

  it("counts only the enrollment this run sent as success", async () => {
    const { result } = await run({
      onPair: (_pairing, configured) => {
        configured.state.connection = "online";
        configured.state.pairing = {
          deploymentId,
          deploymentName,
          enrollmentId: "ren_somebody_else",
          hostUrl,
          runnerId: phoneRunnerId,
        };
      },
    });
    expect(issueOf(result)).toBe("pairing-timed-out");
  });

  it("does nothing to a phone that is already set up", async () => {
    const { host, phone, result } = await run(completePhone(), {
      configureHost: (configured) => {
        configured.connected.add(phoneRunnerId);
      },
    });
    expect(result.outcome).toBe("done");
    expect(phone.installs).toBe(0);
    expect(phone.commands.some((argv) => argv[0] === "settings" && argv[1] === "put")).toBe(false);
    expect(host.targetReads).toBe(1);
    expect(phone.retargets).toEqual([]);
    expect(host.mints).toEqual([]);
    expect(host.accessSets).toEqual([]);
  });

  it("reports a phone app that never answers its status", async () => {
    const { host, result } = await run({ answersStatus: false });
    expect(issueOf(result)).toBe("phone-app-unresponsive");
    expect(host.mints).toEqual([]);
  });

  it("stops polling when setup is cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("The person closed setup.");
    let commandsAtAbort = 0;
    let phone: FakePhone | null = null;
    const outcome = run(
      {
        beforeStatus: (configured) => {
          phone = configured;
          if (configured.state.connection === "pairing" && !controller.signal.aborted) {
            commandsAtAbort = configured.commands.length;
            controller.abort(reason);
          }
        },
        onPair: () => undefined,
      },
      { signal: controller.signal },
    );
    await expect(outcome).rejects.toBe(reason);
    expect((phone as FakePhone | null)?.commands.length).toBe(commandsAtAbort);
  });
});

describe("one dialog's enrollments", () => {
  /**
   * A phone that tries the enrollment it holds whenever it has a network and
   * setup asks how it is doing. `network.dropsOnPair` takes the network away
   * the moment a new pairing arrives, so setup times out while the token ages.
   */
  function phoneOnFlakyNetwork(host: () => FakeHost) {
    const network = { dropsOnPair: false, up: false };
    const phone = new FakePhone({
      beforeStatus: (configured) => {
        if (configured.state.connection !== "pairing" || configured.state.pairing === null) return;
        if (network.up) host().redeem(configured);
        else configured.state.issue = { code: "host-unreachable", detail: "No network." };
      },
      onPair: () => {
        if (network.dropsOnPair) network.up = false;
      },
    });
    return { network, phone };
  }

  it("mints a fresh enrollment on Try again however long the dialog stays open", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    let host!: FakeHost;
    const { network, phone } = phoneOnFlakyNetwork(() => host);
    host = new FakeHost(phone);
    const existing = { host, phone };

    // The phone has no network; the person waits, then presses Try again.
    const first = await run({}, { dialog, existing });
    expect(issueOf(first.result)).toBe("host-unreachable");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.advanceTimersByTime(enrollmentLifetimeMs + 60_000);
      // The phone gets a network just long enough to learn its code ran out.
      network.up = true;
      network.dropsOnPair = true;
      const again = await run({}, { dialog, existing });
      expect(issueOf(again.result)).toBe("host-unreachable");
      expect(host.usable().length).toBeLessThanOrEqual(1);
    }
    vi.advanceTimersByTime(enrollmentLifetimeMs + 60_000);
    network.up = true;
    network.dropsOnPair = false;
    const last = await run({}, { dialog, existing });

    expect(last.result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(host.calls).toEqual([
      "mint dialog:0 Pixel 7",
      "retire ren_0: expired",
      "mint dialog:1 Pixel 7",
      "retire ren_1: expired",
      "mint dialog:2 Pixel 7",
      "retire ren_2: expired",
      "mint dialog:3 Pixel 7",
      "retire ren_3: expired",
      "mint dialog:4 Pixel 7",
    ]);
    expect(phone.pairs.map(({ enrollmentId }) => enrollmentId)).toEqual([
      "ren_0",
      "ren_1",
      "ren_2",
      "ren_3",
      "ren_4",
    ]);
  });

  it("sends the dialog's enrollment again, however close to expiring, while the Host lists it", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    const phone = new FakePhone();
    const host = new FakeHost(phone);
    // Unplugged between the mint and the pairing.
    host.afterMint = () => {
      phone.unplugged = true;
    };
    await expect(run({}, { dialog, existing: { host, phone } })).rejects.toThrow(
      "The USB connection closed.",
    );
    expect(phone.pairs).toEqual([]);
    host.afterMint = null;

    vi.advanceTimersByTime(enrollmentLifetimeMs - 5_000);
    phone.unplugged = false;
    const resumed = await run({}, { dialog, existing: { host, phone } });

    expect(resumed.result.outcome).toBe("done");
    expect(keysOf(host)).toEqual(["dialog:0"]);
    expect(phone.pairs.map(({ enrollmentId }) => enrollmentId)).toEqual(["ren_0"]);
  });

  it("asks again under the same key and request when a mint's answer was lost", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    const phone = new FakePhone();
    const host = new FakeHost(phone);
    host.losesNextMintAnswer = true;
    await expect(run({}, { dialog, existing: { host, phone } })).rejects.toThrow(
      "The connection to the Host closed.",
    );
    const retried = await run({}, { dialog, existing: { host, phone } });

    expect(retried.result.outcome).toBe("done");
    expect(host.mints).toEqual([
      { idempotencyKey: "dialog:0", name: "Pixel 7" },
      { idempotencyKey: "dialog:0", name: "Pixel 7" },
    ]);
    expect(host.enrollments.size).toBe(1);
    expect(phone.pairs.map(({ enrollmentId }) => enrollmentId)).toEqual(["ren_0"]);
  });

  it("moves on from an enrollment the removed phone already redeemed once the Host says so", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    let host!: FakeHost;
    const { network, phone } = phoneOnFlakyNetwork(() => host);
    host = new FakeHost(phone);
    network.up = true;
    const first = await run({}, { dialog, existing: { host, phone } });
    expect(first.result.outcome).toBe("done");

    // Removed from Opensteer elsewhere while the dialog stayed open.
    phone.state.pairing = null;
    phone.state.connection = "removed";
    phone.state.issue = { code: "removed", detail: "This phone's identity and keys were erased." };
    host.connected.clear();
    const again = await run({}, { dialog, existing: { host, phone } });

    expect(again.result).toEqual({ outcome: "done", runnerId: phoneRunnerId });
    expect(host.calls).toEqual([
      "mint dialog:0 Pixel 7",
      "retire ren_0: consumed",
      "mint dialog:1 Pixel 7",
    ]);
    expect(phone.pairs.map(({ enrollmentId }) => enrollmentId)).toEqual([
      "ren_0",
      "ren_0",
      "ren_1",
    ]);
  });

  it("retires the dialog's enrollment before minting one for another phone", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    const first = await run({ onPair: failsWith("host-unreachable", "No network.") }, { dialog });
    expect(issueOf(first.result)).toBe("host-unreachable");

    const other = new FakePhone();
    const host = first.host;
    host.phone = other;
    const second = await run(
      {},
      { dialog, existing: { host, phone: other }, runnerName: "Galaxy S24" },
    );

    expect(second.result.outcome).toBe("done");
    expect(host.calls).toEqual([
      "mint dialog:0 Pixel 7",
      "retire ren_0: retired",
      "mint dialog:1 Galaxy S24",
    ]);
    expect(host.usable()).toEqual(["ren_1"]);
  });

  it("finishes a mint whose answer was lost under its own key, then retires it, before another phone's", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    const phone = new FakePhone();
    const host = new FakeHost(phone);
    host.losesNextMintAnswer = true;
    await expect(run({}, { dialog, existing: { host, phone } })).rejects.toThrow(
      "The connection to the Host closed.",
    );

    const other = new FakePhone();
    host.phone = other;
    const second = await run(
      {},
      { dialog, existing: { host, phone: other }, runnerName: "Galaxy S24" },
    );

    expect(second.result.outcome).toBe("done");
    expect(host.calls).toEqual([
      "mint dialog:0 Pixel 7",
      "mint dialog:0 Pixel 7",
      "retire ren_0: retired",
      "mint dialog:1 Galaxy S24",
    ]);
    expect(host.usable()).toEqual(["ren_1"]);
  });

  it("keeps the dialog's enrollment however many newer ones the owner has pending", async () => {
    const dialog = new AgentPhoneEnrollments("dialog");
    const first = await run({ onPair: failsWith("host-unreachable", "No network.") }, { dialog });
    expect(issueOf(first.result)).toBe("host-unreachable");
    const { host, phone } = first;
    host.mintElsewhere(150);
    // The app's data was cleared, so the phone no longer holds the enrollment.
    phone.state.pairing = null;
    phone.state.connection = "unpaired";
    phone.state.issue = null;
    Object.assign(phone.options, { onPair: onlineOnNextStatus });
    const again = await run({}, { dialog, existing: { host, phone } });

    expect(again.result.outcome).toBe("done");
    expect(host.calls).toEqual(["mint dialog:0 Pixel 7"]);
    expect(phone.pairs.map(({ enrollmentId }) => enrollmentId)).toEqual(["ren_0", "ren_0"]);
  });
});
