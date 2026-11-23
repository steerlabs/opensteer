import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => CommandResult;

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
  readonly authDbRelaxed?: SystemCaCleanupStep | null;
  readonly authDbRestored?: SystemCaCleanupStep | null;
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

export function defaultCommandRunner(
  command: string,
  args: readonly string[],
  stdin?: string,
): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    ...(stdin !== undefined ? { input: stdin } : {}),
  });
  return {
    ...(result.error ? { error: result.error } : {}),
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

/**
 * Generates a distinct root CA and localhost leaf certificate for the VM
 * system-CA smoke. Uses separate OpenSSL config files for the root and leaf
 * CSRs because macOS LibreSSL ignores `-subj` when `[req]` sets `prompt=no`;
 * a shared config produces a leaf whose subject equals the root's subject,
 * which OpenSSL 3.5 rejects as `DEPTH_ZERO_SELF_SIGNED_CERT` even when the
 * root is trusted.
 */
export function generateSystemCaFixtureCertificates(options: {
  readonly commonName: string;
  readonly rootDer: string;
  readonly rootPem: string;
  readonly workDir: string;
  readonly opensslPath?: string;
  readonly runCommand?: CommandRunner;
}): {
  readonly cert: string;
  readonly fingerprint: string;
  readonly key: string;
  readonly rootPemText: string;
} {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const openssl = options.opensslPath ?? "/usr/bin/openssl";
  const execOrThrow = (args: readonly string[]): string => {
    const result = runCommand(openssl, args);
    if (result.status !== 0) {
      throw new Error(formatCommandFailure(openssl, args, result));
    }
    return result.stdout;
  };
  const rootConfig = path.join(options.workDir, "root.cnf");
  const leafConfig = path.join(options.workDir, "leaf.cnf");
  writeFileSync(
    rootConfig,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${options.commonName}\n[root]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`,
  );
  writeFileSync(
    leafConfig,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n`,
  );
  const rootKey = path.join(options.workDir, "root.key");
  const leafKey = path.join(options.workDir, "leaf.key");
  const leafCsr = path.join(options.workDir, "leaf.csr");
  const leafPem = path.join(options.workDir, "leaf.pem");
  execOrThrow([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    rootKey,
    "-out",
    options.rootPem,
    "-days",
    "2",
    "-config",
    rootConfig,
    "-extensions",
    "root",
  ]);
  execOrThrow(["x509", "-in", options.rootPem, "-outform", "DER", "-out", options.rootDer]);
  execOrThrow([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    leafKey,
    "-out",
    leafCsr,
    "-config",
    leafConfig,
  ]);
  execOrThrow([
    "x509",
    "-req",
    "-in",
    leafCsr,
    "-CA",
    options.rootPem,
    "-CAkey",
    rootKey,
    "-CAcreateserial",
    "-out",
    leafPem,
    "-days",
    "2",
    "-extfile",
    leafConfig,
    "-extensions",
    "leaf",
  ]);
  const rootPemText = readFileSync(options.rootPem, "utf8");
  const cert = readFileSync(leafPem, "utf8");
  const rootX509 = new X509Certificate(rootPemText);
  const leafX509 = new X509Certificate(cert);
  if (leafX509.subject === leafX509.issuer) {
    throw new Error(
      `System CA fixture leaf certificate must not be self-issued (subject=${leafX509.subject})`,
    );
  }
  if (leafX509.issuer !== rootX509.subject) {
    throw new Error(
      `System CA fixture leaf issuer (${leafX509.issuer}) does not match root subject (${rootX509.subject})`,
    );
  }
  return {
    cert,
    fingerprint: rootX509.fingerprint256,
    key: readFileSync(leafKey, "utf8"),
    rootPemText,
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

function isAuthorizationDeniedSecurityError(stderr: string): boolean {
  return /authorization was denied|no user interaction was possible|errAuthorizationDenied|errAuthorizationInteractionNotAllowed/iu.test(
    stderr,
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
  options?: { readonly allowNotFound?: boolean; readonly stdin?: string },
): SystemCaCleanupStep {
  try {
    const result = runCommand(command, args, options?.stdin);
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

  let sha1: string | null = null;
  if (existsSync(options.rootPem)) {
    try {
      sha1 = new X509Certificate(readFileSync(options.rootPem, "utf8")).fingerprint
        .replaceAll(":", "")
        .toUpperCase();
    } catch {
      sha1 = null;
    }
  }

  let removeTrustedCert = runSecurityStep(
    runCommand,
    "/usr/bin/sudo",
    ["-n", "/usr/bin/security", "remove-trusted-cert", "-d", options.rootPem],
    { allowNotFound: true },
  );

  let removeTrustedCertDer: SystemCaCleanupStep | null = null;
  let restoreAdminTrustSettings: SystemCaCleanupStep | null = null;
  let authDbRelaxed: SystemCaCleanupStep | null = null;
  let authDbRestored: SystemCaCleanupStep | null = null;

  // In a headless disposable VM, `add-trusted-cert -d` succeeds under `sudo -n`,
  // while `remove-trusted-cert -d` and `trust-settings-import -d` evaluate the
  // `com.apple.trust-settings.admin` right and fail with "no user interaction
  // was possible". Temporarily relax that right for the removal and restore its
  // saved definition in `finally`.
  if (!removeTrustedCert.ok && isAuthorizationDeniedSecurityError(removeTrustedCert.stderr)) {
    const priorAuthDb = runSecurityStep(runCommand, "/usr/bin/security", [
      "authorizationdb",
      "read",
      "com.apple.trust-settings.admin",
    ]);
    if (priorAuthDb.ok && priorAuthDb.stdout.length > 0) {
      authDbRelaxed = runSecurityStep(runCommand, "/usr/bin/sudo", [
        "-n",
        "/usr/bin/security",
        "authorizationdb",
        "write",
        "com.apple.trust-settings.admin",
        "allow",
      ]);
      try {
        if (authDbRelaxed.ok) {
          removeTrustedCert = runSecurityStep(
            runCommand,
            "/usr/bin/sudo",
            ["-n", "/usr/bin/security", "remove-trusted-cert", "-d", options.rootPem],
            { allowNotFound: true },
          );
          if (!removeTrustedCert.ok && existsSync(options.rootDer)) {
            removeTrustedCertDer = runSecurityStep(
              runCommand,
              "/usr/bin/sudo",
              ["-n", "/usr/bin/security", "remove-trusted-cert", "-d", options.rootDer],
              { allowNotFound: true },
            );
          }
          if (
            !removeTrustedCert.ok &&
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
      } finally {
        if (authDbRelaxed.ok) {
          authDbRestored = runSecurityStep(
            runCommand,
            "/usr/bin/sudo",
            [
              "-n",
              "/usr/bin/security",
              "authorizationdb",
              "write",
              "com.apple.trust-settings.admin",
            ],
            { stdin: `${priorAuthDb.stdout}\n` },
          );
        }
      }
    }
  }

  if (!removeTrustedCert.ok && !removeTrustedCertDer && !restoreAdminTrustSettings) {
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

  // `security find-certificate -Z` prints hashes rather than filtering by one;
  // passing `-a -Z` lists every hash in System.keychain so we check specifically
  // for this fixture's SHA-256 instead of matching unrelated system certs.
  const findAfter = runSecurityStep(runCommand, "/usr/bin/security", [
    "find-certificate",
    "-a",
    "-Z",
    "/Library/Keychains/System.keychain",
  ]);
  const certPresentAfterCleanup =
    findAfter.status === 0
      ? findAfter.stdout.toUpperCase().includes(sha256)
      : isNotFoundSecurityError(findAfter.stderr)
        ? false
        : null;

  const dumpTrustAfter = runSecurityStep(runCommand, "/usr/bin/security", [
    "dump-trust-settings",
    "-d",
  ]);
  let trustPresentAfterCleanup: boolean | null =
    dumpTrustAfter.status === 0
      ? dumpTrustAfter.stdout.includes(options.commonName) ||
        dumpTrustAfter.stdout.toUpperCase().includes(sha256) ||
        (sha1 !== null && dumpTrustAfter.stdout.toUpperCase().includes(sha1))
      : isNotFoundSecurityError(dumpTrustAfter.stderr)
        ? false
        : null;
  // Also inspect raw exported admin trust settings so an orphaned trust entry
  // whose certificate was deleted from System.keychain cannot hide as absent.
  const afterTrustPlist = path.join(options.workDir, "after-trust.plist");
  const exportAfter = runSecurityStep(runCommand, "/usr/bin/security", [
    "trust-settings-export",
    "-d",
    afterTrustPlist,
  ]);
  if (exportAfter.ok && existsSync(afterTrustPlist)) {
    const exportedText = readFileSync(afterTrustPlist, "utf8").toUpperCase();
    const stillInPlist =
      exportedText.includes(sha256) ||
      (sha1 !== null && exportedText.includes(sha1)) ||
      exportedText.includes(options.commonName.toUpperCase());
    if (stillInPlist) trustPresentAfterCleanup = true;
    else if (trustPresentAfterCleanup === null) trustPresentAfterCleanup = false;
  }

  const authDbOk = authDbRelaxed === null || (authDbRelaxed.ok && authDbRestored?.ok === true);
  const restored =
    certPresentAfterCleanup === false && trustPresentAfterCleanup === false && authDbOk;

  const cleanup: SystemCaCleanupReport = {
    ...(authDbRelaxed ? { authDbRelaxed } : {}),
    ...(authDbRestored ? { authDbRestored } : {}),
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

  try {
    rmSync(options.workDir, { force: true, recursive: true });
  } catch {
    // Keep the written report even if temporary directory cleanup fails.
  }

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
      authDbRelaxed && !authDbRelaxed.ok ? `authorizationdb allow: ${authDbRelaxed.stderr}` : null,
      authDbRestored && !authDbRestored.ok
        ? `authorizationdb restore: ${authDbRestored.stderr}`
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
