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

export type AdminTrustCleanupState = "removed" | "revoked-deny" | "trusted" | "unknown";

export interface SystemCaCleanupReport {
  readonly priorAdminTrustSettings: "exported" | "none" | "error";
  readonly priorAdminTrustSettingsError?: string | null;
  readonly removeTrustedCert: SystemCaCleanupStep | null;
  readonly removeTrustedCertDer?: SystemCaCleanupStep | null;
  readonly revokeTrustedCert?: SystemCaCleanupStep | null;
  readonly restoreAdminTrustSettings?: SystemCaCleanupStep | null;
  readonly deleteCertificate: SystemCaCleanupStep | null;
  readonly deleteCertificateByName?: SystemCaCleanupStep | null;
  readonly certPresentAfterCleanup: boolean | null;
  readonly trustStateAfterCleanup: AdminTrustCleanupState;
  readonly trustPresentAfterCleanup: boolean | null;
  readonly cleanupProbe?: Record<string, unknown> | null;
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
  readonly verifyCleanupProbe?: () => Promise<Record<string, unknown>>;
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

function extractPlistDictForKey(plistXml: string, key: string): string | null {
  const keyPattern = new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*<dict>`, "iu");
  const match = keyPattern.exec(plistXml);
  if (!match) return null;
  const openStart = match.index + match[0].length - "<dict>".length;
  let depth = 0;
  const tagPattern = /<\/?dict(?:\s*\/)?>/giu;
  tagPattern.lastIndex = openStart;
  let token = tagPattern.exec(plistXml);
  while (token !== null) {
    const text = token[0].toLowerCase();
    if (text === "<dict>") {
      depth += 1;
    } else if (text === "</dict>") {
      depth -= 1;
      if (depth === 0) {
        return plistXml.slice(openStart, token.index + token[0].length);
      }
    }
    token = tagPattern.exec(plistXml);
  }
  return null;
}

/**
 * Inspects XML output from `security trust-settings-export -d` for a fixture
 * root certificate.
 * - `"removed"` when neither the certificate's SHA-1/SHA-256 key nor common name appears.
 * - `"revoked-deny"` when the certificate entry exists in `trustList` and every
 *   `trustSettings` usage-constraint dictionary explicitly sets
 *   `kSecTrustSettingsResult = 3` (`kSecTrustSettingsResultDeny`). An empty
 *   `trustSettings` array defaults to `kSecTrustSettingsResultTrustRoot` in
 *   macOS Security.framework, so it is treated as `"trusted"`.
 * - `"trusted"` otherwise.
 */
export function inspectExportedAdminTrustState(
  plistXml: string,
  identifiers: {
    readonly commonName: string;
    readonly sha1: string | null;
    readonly sha256: string;
  },
): AdminTrustCleanupState {
  const upper = plistXml.toUpperCase();
  const hasSha1 = identifiers.sha1 !== null && upper.includes(identifiers.sha1);
  const hasSha256 = upper.includes(identifiers.sha256);
  const hasCommonName = upper.includes(identifiers.commonName.toUpperCase());
  if (!hasSha1 && !hasSha256 && !hasCommonName) {
    return "removed";
  }

  const certDict =
    (identifiers.sha1 ? extractPlistDictForKey(plistXml, identifiers.sha1) : null) ??
    extractPlistDictForKey(plistXml, identifiers.sha256);
  if (!certDict) {
    return "trusted";
  }
  const arrayMatch = /<key>\s*trustSettings\s*<\/key>\s*<array>([\s\S]*?)<\/array>/iu.exec(
    certDict,
  );
  if (!arrayMatch) {
    return "trusted";
  }
  const entries = [...arrayMatch[1]!.matchAll(/<dict>([\s\S]*?)<\/dict>/giu)];
  if (entries.length === 0) {
    return "trusted";
  }
  for (const entry of entries) {
    const body = entry[1]!;
    const results = [
      ...body.matchAll(
        /<key>\s*kSecTrustSettingsResult\s*<\/key>\s*<integer>\s*(\d+)\s*<\/integer>/giu,
      ),
    ];
    if (results.length === 0 || results.some((r) => r[1] !== "3")) {
      return "trusted";
    }
  }
  return "revoked-deny";
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

  const removeTrustedCert = runSecurityStep(
    runCommand,
    "/usr/bin/sudo",
    ["-n", "/usr/bin/security", "remove-trusted-cert", "-d", options.rootPem],
    { allowNotFound: true },
  );

  let removeTrustedCertDer: SystemCaCleanupStep | null = null;
  let revokeTrustedCert: SystemCaCleanupStep | null = null;
  let restoreAdminTrustSettings: SystemCaCleanupStep | null = null;

  // On modern macOS in a headless VM, `SecTrustSettingsSetTrustSettings`
  // (`add-trusted-cert -d`) permits root (`euid == 0`) without interactive GUI
  // authorization, whereas `SecTrustSettingsRemoveTrustSettings`
  // (`remove-trusted-cert -d`), `SecTrustSettingsImportExternalRepresentation`
  // (`trust-settings-import -d`), and `authorizationdb write` on
  // `com.apple.trust-settings.admin` are denied headlessly. When removal is
  // denied for lack of user interaction, overwrite the fixture root's admin
  // trust setting to `deny` (`kSecTrustSettingsResultDeny = 3`) before deleting
  // the certificate from `System.keychain`.
  if (!removeTrustedCert.ok) {
    if (isAuthorizationDeniedSecurityError(removeTrustedCert.stderr)) {
      revokeTrustedCert = runSecurityStep(runCommand, "/usr/bin/sudo", [
        "-n",
        "/usr/bin/security",
        "add-trusted-cert",
        "-d",
        "-r",
        "deny",
        options.rootPem,
      ]);
    } else {
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
  const listedInDumpAfterCleanup: boolean | null =
    dumpTrustAfter.status === 0
      ? dumpTrustAfter.stdout.includes(options.commonName) ||
        dumpTrustAfter.stdout.toUpperCase().includes(sha256) ||
        (sha1 !== null && dumpTrustAfter.stdout.toUpperCase().includes(sha1))
      : isNotFoundSecurityError(dumpTrustAfter.stderr)
        ? false
        : null;

  // Inspect raw exported admin trust settings so an orphaned `trustRoot` entry
  // cannot hide as absent, while an explicit `deny` revocation is verified.
  const afterTrustPlist = path.join(options.workDir, "after-trust.plist");
  const exportAfter = runSecurityStep(runCommand, "/usr/bin/security", [
    "trust-settings-export",
    "-d",
    afterTrustPlist,
  ]);
  let trustStateAfterCleanup: AdminTrustCleanupState = "unknown";
  if (exportAfter.ok && existsSync(afterTrustPlist)) {
    trustStateAfterCleanup = inspectExportedAdminTrustState(readFileSync(afterTrustPlist, "utf8"), {
      commonName: options.commonName,
      sha1,
      sha256,
    });
  } else if (isNotFoundSecurityError(exportAfter.stderr)) {
    trustStateAfterCleanup = "removed";
  } else if (listedInDumpAfterCleanup === false) {
    trustStateAfterCleanup = "removed";
  } else if (listedInDumpAfterCleanup === true) {
    trustStateAfterCleanup = "trusted";
  }

  let cleanupProbe: Record<string, unknown> | null = null;
  if (added && options.verifyCleanupProbe) {
    try {
      cleanupProbe = await options.verifyCleanupProbe();
    } catch (error) {
      cleanupProbe = { error: formatError(error), listed: null, reached: null };
    }
  }

  try {
    options.closeServer?.();
  } catch {
    // Ignore close errors during cleanup.
  }

  const cleanupProbeOk =
    cleanupProbe === null || (cleanupProbe.listed === false && cleanupProbe.reached === false);

  const trustPresentAfterCleanup: boolean | null =
    listedInDumpAfterCleanup === true || trustStateAfterCleanup === "trusted"
      ? true
      : trustStateAfterCleanup === "removed"
        ? false
        : trustStateAfterCleanup === "revoked-deny" &&
            revokeTrustedCert?.ok === true &&
            certPresentAfterCleanup === false &&
            cleanupProbeOk
          ? false
          : trustStateAfterCleanup === "unknown"
            ? null
            : true;

  const restored =
    certPresentAfterCleanup === false && trustPresentAfterCleanup === false && cleanupProbeOk;

  const cleanup: SystemCaCleanupReport = {
    certPresentAfterCleanup,
    ...(cleanupProbe ? { cleanupProbe } : {}),
    deleteCertificate,
    ...(deleteCertificateByName ? { deleteCertificateByName } : {}),
    priorAdminTrustSettings,
    ...(priorAdminTrustSettings === "error"
      ? { priorAdminTrustSettingsError: exportPrior.stderr }
      : {}),
    removeTrustedCert,
    ...(removeTrustedCertDer ? { removeTrustedCertDer } : {}),
    ...(restoreAdminTrustSettings ? { restoreAdminTrustSettings } : {}),
    ...(revokeTrustedCert ? { revokeTrustedCert } : {}),
    restored,
    trustPresentAfterCleanup,
    trustStateAfterCleanup,
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
      revokeTrustedCert && !revokeTrustedCert.ok
        ? `revoke-trusted-cert (-r deny): ${revokeTrustedCert.stderr}`
        : null,
      restoreAdminTrustSettings && !restoreAdminTrustSettings.ok
        ? `trust-settings-import: ${restoreAdminTrustSettings.stderr}`
        : null,
      deleteCertificate.ok ? null : `delete-certificate: ${deleteCertificate.stderr}`,
      deleteCertificateByName && !deleteCertificateByName.ok
        ? `delete-certificate (-c): ${deleteCertificateByName.stderr}`
        : null,
      `certPresentAfterCleanup=${String(certPresentAfterCleanup)}`,
      `trustStateAfterCleanup=${trustStateAfterCleanup}`,
      `trustPresentAfterCleanup=${String(trustPresentAfterCleanup)}`,
      ...(cleanupProbe && !cleanupProbeOk ? [`cleanupProbe=${JSON.stringify(cleanupProbe)}`] : []),
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Guest trust store was not restored cleanly: ${details}`);
  }
  return report;
}
