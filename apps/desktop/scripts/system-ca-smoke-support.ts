import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

export interface SystemCaCleanupStep {
  readonly command: readonly string[];
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly alreadyAbsent?: boolean;
  readonly ok: boolean;
}

export interface SystemCaCleanupReport {
  readonly priorAdminTrustSettings: "exported" | "none" | "error";
  readonly priorAdminTrustSettingsError?: string | null;
  readonly removeTrustedCert: SystemCaCleanupStep | null;
  readonly removeTrustedCertDer?: SystemCaCleanupStep | null;
  readonly restoreAdminTrustSettings?: SystemCaCleanupStep | null;
  readonly deleteCertificate: SystemCaCleanupStep | null;
  readonly deleteCertificateByName?: SystemCaCleanupStep | null;
  readonly certPresentAfterCleanup: boolean | null;
  readonly trustPresentAfterCleanup: boolean | null;
  readonly restored: boolean;
}

export interface SystemCaSmokeReport {
  readonly node: unknown;
  readonly commonName: string;
  readonly fingerprint: string;
  readonly added: boolean;
  readonly rows: readonly Record<string, unknown>[];
  readonly error: string | null;
  readonly cleanup: SystemCaCleanupReport;
}

export interface RunSystemCaSmokeOptions {
  readonly artifactsDir: string;
  readonly commonName: string;
  readonly fingerprint: string;
  readonly nodeIdentity: unknown;
  readonly priorTrustPlist: string;
  readonly rootDer: string;
  readonly rootPem: string;
  readonly workDir: string;
  readonly runCommand?: CommandRunner;
  readonly runProbes: (rows: Record<string, unknown>[]) => Promise<void>;
  readonly closeServer?: () => void;
}

export function defaultCommandRunner(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export function isNotFoundSecurityError(stderr: string): boolean {
  return (
    /No Trust Settings were found/iu.test(stderr) ||
    /The specified item could not be found/iu.test(stderr) ||
    /could not be found in the keychain/iu.test(stderr) ||
    /errSecItemNotFound|errSecNoTrustSettings/iu.test(stderr)
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function formatCommandFailure(
  command: string,
  args: readonly string[],
  result: CommandResult,
): string {
  const detail = [result.error?.message, result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join(" | ");
  return `Command failed (exit ${String(result.status)}): ${[command, ...args].join(" ")}${detail ? `: ${detail}` : ""}`;
}

function runSecurityStep(
  runCommand: CommandRunner,
  command: string,
  args: readonly string[],
  options?: { readonly allowNotFound?: boolean },
): SystemCaCleanupStep {
  try {
    const result = runCommand(command, args);
    const stderr = [result.error?.message, result.stderr].filter(Boolean).join("\n").trim();
    const stdout = result.stdout.trim();
    const alreadyAbsent =
      result.status !== 0 && options?.allowNotFound === true && isNotFoundSecurityError(stderr);
    return {
      ...(alreadyAbsent ? { alreadyAbsent: true } : {}),
      command: [command, ...args],
      ok: result.status === 0 || alreadyAbsent,
      status: result.status,
      stderr,
      stdout,
    };
  } catch (error) {
    return {
      command: [command, ...args],
      ok: false,
      status: null,
      stderr: formatError(error),
      stdout: "",
    };
  }
}

export async function runSystemCaSmokeLifecycle(
  options: RunSystemCaSmokeOptions,
): Promise<SystemCaSmokeReport> {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const sha256 = options.fingerprint.replaceAll(":", "").toUpperCase();
  const rows: Record<string, unknown>[] = [];
  let added = false;
  let primaryError: unknown;

  // Snapshot the guest's admin trust settings before changing anything, so
  // cleanup can restore them even if `remove-trusted-cert` refuses.
  const exportPrior = runSecurityStep(runCommand, "/usr/bin/security", [
    "trust-settings-export",
    "-d",
    options.priorTrustPlist,
  ]);
  const priorAdminTrustSettings: "exported" | "none" | "error" = exportPrior.ok
    ? "exported"
    : isNotFoundSecurityError(exportPrior.stderr)
      ? "none"
      : "error";

  try {
    const addArgs = [
      "-n",
      "/usr/bin/security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      "/Library/Keychains/System.keychain",
      options.rootPem,
    ];
    const addResult = runCommand("/usr/bin/sudo", addArgs);
    if (addResult.status !== 0) {
      throw new Error(formatCommandFailure("/usr/bin/sudo", addArgs, addResult));
    }
    added = true;
    await options.runProbes(rows);
  } catch (error) {
    primaryError = error;
  }

  // Cleanup runs independently of any primary error, never throws out of
  // finally, and never skips deleting the certificate or writing system-ca.json.
  try {
    options.closeServer?.();
  } catch {
    // Ignore close errors during cleanup.
  }

  const removeTrustedCert = runSecurityStep(
    runCommand,
    "/usr/bin/sudo",
    ["-n", "/usr/bin/security", "remove-trusted-cert", "-d", options.rootPem],
    { allowNotFound: true },
  );

  let removeTrustedCertDer: SystemCaCleanupStep | null = null;
  let restoreAdminTrustSettings: SystemCaCleanupStep | null = null;
  if (!removeTrustedCert.ok) {
    if (existsSync(options.rootDer)) {
      removeTrustedCertDer = runSecurityStep(
        runCommand,
        "/usr/bin/sudo",
        ["-n", "/usr/bin/security", "remove-trusted-cert", "-d", options.rootDer],
        { allowNotFound: true },
      );
    }
    if (
      !removeTrustedCertDer?.ok &&
      priorAdminTrustSettings === "exported" &&
      existsSync(options.priorTrustPlist)
    ) {
      restoreAdminTrustSettings = runSecurityStep(runCommand, "/usr/bin/sudo", [
        "-n",
        "/usr/bin/security",
        "trust-settings-import",
        "-d",
        options.priorTrustPlist,
      ]);
    }
  }

  const deleteCertificate = runSecurityStep(
    runCommand,
    "/usr/bin/sudo",
    [
      "-n",
      "/usr/bin/security",
      "delete-certificate",
      "-Z",
      sha256,
      "/Library/Keychains/System.keychain",
    ],
    { allowNotFound: true },
  );

  let deleteCertificateByName: SystemCaCleanupStep | null = null;
  if (!deleteCertificate.ok) {
    deleteCertificateByName = runSecurityStep(
      runCommand,
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/security",
        "delete-certificate",
        "-c",
        options.commonName,
        "/Library/Keychains/System.keychain",
      ],
      { allowNotFound: true },
    );
  }

  const findAfter = runSecurityStep(runCommand, "/usr/bin/security", [
    "find-certificate",
    "-Z",
    sha256,
    "/Library/Keychains/System.keychain",
  ]);
  const certPresentAfterCleanup =
    findAfter.status === 0 ? true : isNotFoundSecurityError(findAfter.stderr) ? false : null;

  const dumpTrustAfter = runSecurityStep(runCommand, "/usr/bin/security", [
    "dump-trust-settings",
    "-d",
  ]);
  const trustPresentAfterCleanup =
    dumpTrustAfter.status === 0
      ? dumpTrustAfter.stdout.includes(options.commonName) ||
        dumpTrustAfter.stdout.toUpperCase().includes(sha256)
      : isNotFoundSecurityError(dumpTrustAfter.stderr)
        ? false
        : null;

  const restored = certPresentAfterCleanup === false && trustPresentAfterCleanup === false;

  rmSync(options.workDir, { force: true, recursive: true });

  const cleanup: SystemCaCleanupReport = {
    certPresentAfterCleanup,
    deleteCertificate,
    ...(deleteCertificateByName ? { deleteCertificateByName } : {}),
    priorAdminTrustSettings,
    ...(priorAdminTrustSettings === "error"
      ? { priorAdminTrustSettingsError: exportPrior.stderr }
      : {}),
    removeTrustedCert,
    ...(removeTrustedCertDer ? { removeTrustedCertDer } : {}),
    ...(restoreAdminTrustSettings ? { restoreAdminTrustSettings } : {}),
    restored,
    trustPresentAfterCleanup,
  };

  const report: SystemCaSmokeReport = {
    added,
    cleanup,
    commonName: options.commonName,
    error: primaryError === undefined ? null : formatError(primaryError),
    fingerprint: options.fingerprint,
    node: options.nodeIdentity,
    rows,
  };

  mkdirSync(options.artifactsDir, { recursive: true });
  writeFileSync(
    path.join(options.artifactsDir, "system-ca.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (!restored) {
    const details = [
      removeTrustedCert.ok ? null : `remove-trusted-cert: ${removeTrustedCert.stderr}`,
      removeTrustedCertDer && !removeTrustedCertDer.ok
        ? `remove-trusted-cert (der): ${removeTrustedCertDer.stderr}`
        : null,
      restoreAdminTrustSettings && !restoreAdminTrustSettings.ok
        ? `trust-settings-import: ${restoreAdminTrustSettings.stderr}`
        : null,
      deleteCertificate.ok ? null : `delete-certificate: ${deleteCertificate.stderr}`,
      deleteCertificateByName && !deleteCertificateByName.ok
        ? `delete-certificate (-c): ${deleteCertificateByName.stderr}`
        : null,
      `certPresentAfterCleanup=${String(certPresentAfterCleanup)}`,
      `trustPresentAfterCleanup=${String(trustPresentAfterCleanup)}`,
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Guest trust store was not restored cleanly: ${details}`);
  }
  return report;
}
