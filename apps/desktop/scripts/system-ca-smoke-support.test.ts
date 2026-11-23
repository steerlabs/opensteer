import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateSystemCaFixtureCertificates,
  runSystemCaSmokeLifecycle,
  type CommandResult,
  type SystemCaSmokeReport,
} from "./system-ca-smoke-support.js";

const tempDirs: string[] = [];

function makeDirs() {
  const root = mkdtempSync(path.join(tmpdir(), "opensteer-system-ca-test-"));
  tempDirs.push(root);
  const workDir = path.join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const artifactsDir = path.join(root, "artifacts");
  const rootPem = path.join(workDir, "root.pem");
  const rootDer = path.join(workDir, "root.der");
  const priorTrustPlist = path.join(workDir, "prior-trust.plist");
  return { artifactsDir, priorTrustPlist, root, rootDer, rootPem, workDir };
}

function ok(stdout = "", stderr = ""): CommandResult {
  return { status: 0, stderr, stdout };
}

function fail(stderr: string, status = 1, stdout = ""): CommandResult {
  return { status, stderr, stdout };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("system-ca smoke lifecycle", () => {
  const fingerprint =
    "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  const sha256 = fingerprint.replaceAll(":", "");

  it("never lets cleanup hide a primary probe error and still deletes the cert and writes system-ca.json", async () => {
    const dirs = makeDirs();
    const calls: string[] = [];
    let certPresent = false;
    let trustPresent = false;

    await expect(
      runSystemCaSmokeLifecycle({
        artifactsDir: dirs.artifactsDir,
        commonName: "Opensteer system CA fixture 1",
        fingerprint,
        nodeIdentity: { version: "24.0.0" },
        priorTrustPlist: dirs.priorTrustPlist,
        rootDer: dirs.rootDer,
        rootPem: dirs.rootPem,
        workDir: dirs.workDir,
        runCommand: (command, args) => {
          calls.push([command, ...args].join(" "));
          const subcommand = args.find((a) => !a.startsWith("-") && a !== "/usr/bin/security");
          if (subcommand === "trust-settings-export") {
            return fail("SecTrustSettingsCopyTrustSettings: No Trust Settings were found.");
          }
          if (subcommand === "add-trusted-cert") {
            certPresent = true;
            trustPresent = true;
            return ok();
          }
          if (subcommand === "remove-trusted-cert") {
            return fail("SecTrustSettingsRemoveTrustSettings: Authorization denied.");
          }
          if (subcommand === "delete-certificate") {
            certPresent = false;
            return ok();
          }
          if (subcommand === "find-certificate") {
            return certPresent
              ? ok(`SHA-256 hash: ${sha256}\n`)
              : fail("The specified item could not be found in the keychain.");
          }
          if (subcommand === "dump-trust-settings") {
            return trustPresent
              ? ok("Cert 0: Opensteer system CA fixture 1")
              : fail("No Trust Settings were found.");
          }
          return ok();
        },
        runProbes: async (rows) => {
          rows.push({ listed: true, process: "home-node", reached: true, setting: "on" });
          throw new Error("utility-runner crashed before posting");
        },
      }),
    ).rejects.toThrow("utility-runner crashed before posting");

    // delete-certificate still ran despite remove-trusted-cert failing.
    expect(calls.some((c) => c.includes("delete-certificate"))).toBe(true);
    expect(certPresent).toBe(false);
    // Result file was written with the observed row, primary error, and cleanup details.
    const reportPath = path.join(dirs.artifactsDir, "system-ca.json");
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as SystemCaSmokeReport;
    expect(report.added).toBe(true);
    expect(report.rows).toEqual([
      { listed: true, process: "home-node", reached: true, setting: "on" },
    ]);
    expect(report.error).toContain("utility-runner crashed before posting");
    expect(report.cleanup.removeTrustedCert?.stderr).toContain("Authorization denied");
    expect(report.cleanup.restored).toBe(false);
  });

  it("treats removing a certificate that is not trusted as non-fatal and restores the trust store", async () => {
    const dirs = makeDirs();
    let certPresent = false;

    const report = await runSystemCaSmokeLifecycle({
      artifactsDir: dirs.artifactsDir,
      commonName: "Opensteer system CA fixture 2",
      fingerprint,
      nodeIdentity: { version: "24.0.0" },
      priorTrustPlist: dirs.priorTrustPlist,
      rootDer: dirs.rootDer,
      rootPem: dirs.rootPem,
      workDir: dirs.workDir,
      runCommand: (_command, args) => {
        const subcommand = args.find((a) => !a.startsWith("-") && a !== "/usr/bin/security");
        if (subcommand === "trust-settings-export") {
          return fail("SecTrustSettingsCopyTrustSettings: No Trust Settings were found.");
        }
        if (subcommand === "add-trusted-cert") {
          certPresent = true;
          return ok();
        }
        if (subcommand === "remove-trusted-cert") {
          return fail("SecTrustSettingsRemoveTrustSettings: No Trust Settings were found.");
        }
        if (subcommand === "delete-certificate") {
          expect(args).toContain(sha256);
          certPresent = false;
          return ok();
        }
        if (subcommand === "find-certificate") {
          return certPresent
            ? ok(`SHA-256 hash: ${sha256}\n`)
            : fail("The specified item could not be found in the keychain.");
        }
        if (subcommand === "dump-trust-settings") {
          return fail("SecTrustSettingsCopyTrustSettings: No Trust Settings were found.");
        }
        return ok();
      },
      runProbes: async (rows) => {
        rows.push(
          { listed: true, process: "home-node", reached: true, setting: "on" },
          { listed: true, process: "utility-runner", reached: true, setting: "on" },
          { listed: false, process: "home-node", reached: false, setting: "off" },
          { listed: false, process: "utility-runner", reached: false, setting: "off" },
        );
      },
    });

    expect(report.error).toBeNull();
    expect(report.cleanup.removeTrustedCert?.alreadyAbsent).toBe(true);
    expect(report.cleanup.restored).toBe(true);
    expect(report.rows).toHaveLength(4);
    expect(existsSync(path.join(dirs.artifactsDir, "system-ca.json"))).toBe(true);
  });

  it("writes system-ca.json and still cleans up when add-trusted-cert itself fails", async () => {
    const dirs = makeDirs();
    const calls: string[] = [];

    await expect(
      runSystemCaSmokeLifecycle({
        artifactsDir: dirs.artifactsDir,
        commonName: "Opensteer system CA fixture 3",
        fingerprint,
        nodeIdentity: { version: "24.0.0" },
        priorTrustPlist: dirs.priorTrustPlist,
        rootDer: dirs.rootDer,
        rootPem: dirs.rootPem,
        workDir: dirs.workDir,
        runCommand: (command, args) => {
          calls.push([command, ...args].join(" "));
          const subcommand = args.find((a) => !a.startsWith("-") && a !== "/usr/bin/security");
          if (subcommand === "trust-settings-export") {
            return fail("SecTrustSettingsCopyTrustSettings: No Trust Settings were found.");
          }
          if (subcommand === "add-trusted-cert") {
            return fail("sudo: a password is required");
          }
          if (subcommand === "remove-trusted-cert" || subcommand === "delete-certificate") {
            return fail("The specified item could not be found in the keychain.");
          }
          if (subcommand === "find-certificate" || subcommand === "dump-trust-settings") {
            return fail("No Trust Settings were found.");
          }
          return ok();
        },
        runProbes: async () => {
          throw new Error("should not run probes after add-trusted-cert failed");
        },
      }),
    ).rejects.toThrow("sudo: a password is required");

    const report = JSON.parse(
      readFileSync(path.join(dirs.artifactsDir, "system-ca.json"), "utf8"),
    ) as SystemCaSmokeReport;
    expect(report.added).toBe(false);
    expect(report.rows).toEqual([]);
    expect(report.error).toContain("sudo: a password is required");
    expect(report.cleanup.restored).toBe(true);
  });

  it("restores prior admin trust settings plist when remove-trusted-cert fails", async () => {
    const dirs = makeDirs();
    let trustPresent = false;
    let certPresent = false;

    const report = await runSystemCaSmokeLifecycle({
      artifactsDir: dirs.artifactsDir,
      commonName: "Opensteer system CA fixture 4",
      fingerprint,
      nodeIdentity: { version: "24.0.0" },
      priorTrustPlist: dirs.priorTrustPlist,
      rootDer: dirs.rootDer,
      rootPem: dirs.rootPem,
      workDir: dirs.workDir,
      runCommand: (_command, args) => {
        const subcommand = args.find((a) => !a.startsWith("-") && a !== "/usr/bin/security");
        if (subcommand === "trust-settings-export") {
          writeFileSync(dirs.priorTrustPlist, "<plist/>");
          return ok();
        }
        if (subcommand === "add-trusted-cert") {
          certPresent = true;
          trustPresent = true;
          return ok();
        }
        if (subcommand === "remove-trusted-cert") {
          return fail("SecTrustSettingsRemoveTrustSettings: unexpected error");
        }
        if (subcommand === "trust-settings-import") {
          trustPresent = false;
          return ok();
        }
        if (subcommand === "delete-certificate") {
          certPresent = false;
          return ok();
        }
        if (subcommand === "find-certificate") {
          return certPresent
            ? ok(`SHA-256 hash: ${sha256}\n`)
            : fail("The specified item could not be found in the keychain.");
        }
        if (subcommand === "dump-trust-settings") {
          return ok(
            trustPresent ? "Cert 0: Opensteer system CA fixture 4" : "Cert 0: Existing Admin Root",
          );
        }
        return ok();
      },
      runProbes: async (rows) => {
        rows.push({ listed: true, process: "home-node", reached: true, setting: "on" });
      },
    });

    expect(report.cleanup.priorAdminTrustSettings).toBe("exported");
    expect(report.cleanup.restoreAdminTrustSettings?.ok).toBe(true);
    expect(report.cleanup.restored).toBe(true);
  });

  it("H8: checks find-certificate output for the fixture sha256 instead of treating any System.keychain cert as present, and temporarily relaxes com.apple.trust-settings.admin to remove trust in a headless VM", async () => {
    const dirs = makeDirs();
    let certPresent = false;
    let trustPresent = false;
    let authDbRule = "<plist><string>authenticate-admin</string></plist>";
    const calls: string[] = [];

    const report = await runSystemCaSmokeLifecycle({
      artifactsDir: dirs.artifactsDir,
      commonName: "Opensteer system CA fixture 5",
      fingerprint,
      nodeIdentity: { version: "24.0.0" },
      priorTrustPlist: dirs.priorTrustPlist,
      rootDer: dirs.rootDer,
      rootPem: dirs.rootPem,
      workDir: dirs.workDir,
      runCommand: (command, args, stdin) => {
        calls.push([command, ...args].join(" "));
        const subcommand = args.find((a) => !a.startsWith("-") && a !== "/usr/bin/security");
        if (subcommand === "trust-settings-export") {
          const outPath = args.at(-1)!;
          writeFileSync(
            outPath,
            trustPresent
              ? `<plist><string>${sha256}</string></plist>`
              : "<plist><string>prior-only</string></plist>",
          );
          return ok();
        }
        if (subcommand === "add-trusted-cert") {
          certPresent = true;
          trustPresent = true;
          return ok();
        }
        if (subcommand === "authorizationdb") {
          if (args.includes("read")) return ok(authDbRule);
          if (args.includes("write")) {
            authDbRule = args.includes("allow") ? "allow" : (stdin ?? "");
            return ok();
          }
        }
        if (subcommand === "remove-trusted-cert") {
          if (authDbRule !== "allow") {
            return fail(
              "SecTrustSettingsRemoveTrustSettings: The authorization was denied since no user interaction was possible.",
            );
          }
          trustPresent = false;
          return ok();
        }
        if (subcommand === "delete-certificate") {
          certPresent = false;
          return ok();
        }
        if (subcommand === "find-certificate") {
          // Real macOS System.keychain always has other system certs (e.g. Kerberos KDC),
          // so `find-certificate -a -Z` exits 0 even after the fixture cert is deleted.
          const hashes = certPresent
            ? `SHA-256 hash: 1111111111111111111111111111111111111111111111111111111111111111\nSHA-256 hash: ${sha256}\n`
            : "SHA-256 hash: 1111111111111111111111111111111111111111111111111111111111111111\n";
          return ok(hashes);
        }
        if (subcommand === "dump-trust-settings") {
          return ok(
            trustPresent ? "Cert 0: Opensteer system CA fixture 5" : "Cert 0: Existing Admin Root",
          );
        }
        return ok();
      },
      runProbes: async (rows) => {
        rows.push({ listed: true, process: "home-node", reached: true, setting: "on" });
      },
    });

    expect(report.cleanup.certPresentAfterCleanup).toBe(false);
    expect(report.cleanup.trustPresentAfterCleanup).toBe(false);
    expect(report.cleanup.restored).toBe(true);
    expect(authDbRule.trim()).toBe("<plist><string>authenticate-admin</string></plist>");
    expect(calls.some((c) => c.includes("find-certificate -a -Z"))).toBe(true);
  });

  it("H8: generates a non-self-issued localhost leaf signed by the fixture root that Node TLS verifies against the root", async () => {
    const dirs = makeDirs();
    const fixture = generateSystemCaFixtureCertificates({
      commonName: "Opensteer system CA fixture test",
      rootDer: dirs.rootDer,
      rootPem: dirs.rootPem,
      workDir: dirs.workDir,
    });
    const rootX509 = new X509Certificate(fixture.rootPemText);
    const leafX509 = new X509Certificate(fixture.cert);
    expect(leafX509.subject).not.toBe(leafX509.issuer);
    expect(leafX509.issuer).toBe(rootX509.subject);

    const server = createServer({ cert: fixture.cert, key: fixture.key }, (_req, res) =>
      res.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const probe = (ca?: string) =>
      new Promise<{ readonly ok: boolean; readonly code?: string }>((resolve) => {
        httpsGet(url, ca ? { ca } : {}, (res) => {
          res.resume();
          resolve({ ok: res.statusCode === 200 });
        }).on("error", (error: NodeJS.ErrnoException) =>
          resolve({ ok: false, ...(error.code ? { code: error.code } : {}) }),
        );
      });
    try {
      expect(await probe(fixture.rootPemText)).toEqual({ ok: true });
      expect(await probe()).toEqual({ ok: false, code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    } finally {
      server.close();
    }
  });
});
