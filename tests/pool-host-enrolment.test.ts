import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateEgressCredential,
  validateEgressUpstreamUrl,
} from "../apps/control-plane/src/cloud-computers/egress-validation.js";
import { readAgentConfig, refuseUnsupportedMode } from "../apps/pool-agent/src/config.js";
import {
  browserEgressCredentialWritable,
  parseBrowserEgressUpstreamUrl,
} from "../packages/browser-runtime-core/src/browser-egress-upstream.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const enrollScript = join(repoRoot, "apps/pool-agent/host/enroll-host.sh");

function runEnroll(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [enrollScript, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
    };
  }
}

function ed25519SpkiBase64(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

describe("pool host enrolment script (apps/pool-agent/host/enroll-host.sh)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "opensteer-pool-enrol-test-"));
    tempDirs.push(dir);
    return dir;
  }

  describe("X1 profile-disk format-or-not decision table (decide-profile-disk)", () => {
    const validBlkid = [
      "DEVNAME=/dev/sdb",
      "LABEL=opensteer-profiles",
      "UUID=11111111-2222-3333-4444-555555555555",
      "BLOCK_SIZE=4096",
      "TYPE=ext4",
      "USAGE=filesystem",
    ].join("\n");
    const validWipefs =
      "0x438      ext4     11111111-2222-3333-4444-555555555555 opensteer-profiles";

    it("formats and mounts a blank disk only when everEnrolled=false", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("format-and-mount");
    });

    it("refuses a blank disk when everEnrolled=true (never formats an enrolled host's disk)", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("refuse:enrolled-host-blank-disk");
    });

    it("mounts an existing ext4 disk labeled opensteer-profiles on an enrolled host without formatting", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "0",
        "--blkid-out",
        validBlkid,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        validWipefs,
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("mount-only");
    });

    it("mounts an existing ext4 disk labeled opensteer-profiles even when everEnrolled=false (X1 recovery after gen-1 formatted then failed)", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "0",
        "--blkid-out",
        validBlkid,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        validWipefs,
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("mount-only");
    });

    it("refuses an opensteer-profiles disk when the mount check reports failure", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "0",
        "--blkid-out",
        validBlkid,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        validWipefs,
        "--mount-ok",
        "false",
      ]);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("refuse:unmountable-profile-disk");
    });

    it("refuses an unlabeled ext4 disk or an ext4 disk with any other label", () => {
      const unlabeledBlkid = "DEVNAME=/dev/sdb\nTYPE=ext4\nUSAGE=filesystem";
      const unlabeledWipefs = "0x438      ext4     11111111-2222-3333-4444-555555555555";
      for (const everEnrolled of ["false", "true"]) {
        const unlabeled = runEnroll([
          "decide-profile-disk",
          "--ever-enrolled",
          everEnrolled,
          "--blkid-rc",
          "0",
          "--blkid-out",
          unlabeledBlkid,
          "--wipefs-rc",
          "0",
          "--wipefs-out",
          unlabeledWipefs,
        ]);
        expect(unlabeled.status).toBe(1);
        expect(unlabeled.stdout).toBe("refuse:foreign-disk-signature");

        const wrongLabel = runEnroll([
          "decide-profile-disk",
          "--ever-enrolled",
          everEnrolled,
          "--blkid-rc",
          "0",
          "--blkid-out",
          validBlkid.replace("LABEL=opensteer-profiles", "LABEL=foreign-data"),
          "--wipefs-rc",
          "0",
          "--wipefs-out",
          validWipefs.replace("opensteer-profiles", "foreign-data"),
        ]);
        expect(wrongLabel.status).toBe(1);
        expect(wrongLabel.stdout).toBe("refuse:foreign-disk-signature");
      }
    });

    it("refuses another filesystem type, partition tables, and multi-signature disks", () => {
      const xfs = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "0",
        "--blkid-out",
        "DEVNAME=/dev/sdb\nLABEL=opensteer-profiles\nTYPE=xfs",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "0x0        xfs      11111111-2222-3333-4444-555555555555 opensteer-profiles",
      ]);
      expect(xfs.status).toBe(1);
      expect(xfs.stdout).toBe("refuse:foreign-disk-signature");

      const gpt = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "0",
        "--blkid-out",
        `${validBlkid}\nPTTYPE=gpt`,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        `${validWipefs}\n0x200      gpt`,
      ]);
      expect(gpt.status).toBe(1);
      expect(gpt.stdout).toBe("refuse:foreign-disk-signature");

      const multiSig = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "0",
        "--blkid-out",
        validBlkid,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        `${validWipefs}\n0x0        crypto_LUKS`,
      ]);
      expect(multiSig.status).toBe(1);
      expect(multiSig.stdout).toBe("refuse:foreign-disk-signature");
    });

    it("refuses when blkid or wipefs exits with a probe error or disagrees on blankness", () => {
      const blkidErr = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "1",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(blkidErr.status).toBe(1);
      expect(blkidErr.stdout).toBe("refuse:probe-error");

      const wipefsErr = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "1",
        "--wipefs-out",
        "",
      ]);
      expect(wipefsErr.status).toBe(1);
      expect(wipefsErr.stdout).toBe("refuse:probe-error");

      // blkid says blank (rc=2) while wipefs still sees a signature -> refuse!
      const disagree = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "0x1fe      dos",
      ]);
      expect(disagree.status).toBe(1);
      expect(disagree.stdout).toBe("refuse:foreign-disk-signature");

      const badFlag = runEnroll([
        "decide-profile-disk",
        "--ever-enrolled",
        "maybe",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(badFlag.status).toBe(1);
      expect(badFlag.stdout).toBe("refuse:invalid-ever-enrolled");
    });
  });

  describe("agent.json rendering and validation through the real pool-agent config loader", () => {
    function baseBootSpec(overrides: Record<string, unknown> = {}) {
      return {
        hostId: "ph_11111111-1111-4111-8111-111111111111",
        generation: 1,
        accountOrigin: "https://account.example.test",
        installerUrl: "https://releases.example.test/pool-host.sh",
        installerSha256: "a".repeat(64),
        provisionerKey: ed25519SpkiBase64(),
        homeCidr: "10.40.0.0/20",
        provisionerCidr: "10.50.0.0/24",
        profileDiskDevice: "/dev/disk/by-id/google-opensteer-profiles",
        everEnrolled: false,
        agentPort: 7310,
        adminPort: 7311,
        relayPort: 7312,
        ...overrides,
      };
    }

    it("renders an agent.json (mode 0600) that passes readAgentConfig() and refuseUnsupportedMode()", async () => {
      const dir = makeTempDir();
      const specPath = join(dir, "boot-spec.json");
      const outPath = join(dir, "agent.json");
      const spec = baseBootSpec();
      writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });

      const res = runEnroll([
        "render-agent-config",
        "--boot-spec",
        specPath,
        "--relay-uid",
        "987",
        "--out",
        outPath,
      ]);
      expect(res.status).toBe(0);

      const loaded = await readAgentConfig(outPath);
      expect(() => refuseUnsupportedMode(loaded)).not.toThrow();
      expect(loaded.admin).toEqual({
        listen: { host: "0.0.0.0", port: 7311 },
        provisionerKey: spec.provisionerKey,
        hostId: spec.hostId,
        hostKeyFile: "/etc/opensteer-pool/host-key.pem",
      });
      expect(loaded.listen).toEqual({ host: "0.0.0.0", port: 7310 });
      expect(loaded.driver.requireEgressUpstream).toBe(true);
      expect(loaded.driver.egress.accountOrigin).toBe("https://account.example.test");
      expect(loaded.driver.profilesRoot).toBe("/var/lib/opensteer-pool/profiles");
      expect(loaded.driver.credentialsRoot).toBe("/etc/opensteer-pool/credentials");
      expect(loaded.driver.guestMode).toBe("runtime");
      expect(loaded.driver.network.relayUid).toBe(987);

      // Verify readAgentConfig refuses world-readable config files while accepting 0600.
      chmodSync(outPath, 0o644);
      await expect(readAgentConfig(outPath)).rejects.toThrow(/readable by other users/u);
    });

    it("rejects malformed boot specs (missing everEnrolled, non-https origin, bad key, colliding ports, path traversal)", () => {
      const dir = makeTempDir();
      const invalidCases: Array<{ name: string; spec: Record<string, unknown> }> = [
        { name: "missing everEnrolled", spec: baseBootSpec({ everEnrolled: undefined }) },
        {
          name: "http accountOrigin",
          spec: baseBootSpec({ accountOrigin: "http://account.example.test" }),
        },
        {
          name: "accountOrigin with path",
          spec: baseBootSpec({ accountOrigin: "https://account.example.test/v1" }),
        },
        {
          name: "non-Ed25519 provisionerKey",
          spec: baseBootSpec({ provisionerKey: Buffer.alloc(44, 1).toString("base64") }),
        },
        {
          name: "colliding ports",
          spec: baseBootSpec({ agentPort: 7310, adminPort: 7310, relayPort: 7312 }),
        },
        {
          name: "invalid CIDR",
          spec: baseBootSpec({ homeCidr: "not-a-cidr" }),
        },
        {
          name: "profileDiskDevice traversal",
          spec: baseBootSpec({ profileDiskDevice: "/dev/../etc/passwd" }),
        },
      ];

      for (const testCase of invalidCases) {
        const specPath = join(dir, `${testCase.name.replaceAll(/[^a-z0-9]/gi, "-")}.json`);
        writeFileSync(specPath, JSON.stringify(testCase.spec), { mode: 0o600 });
        const res = runEnroll([
          "render-agent-config",
          "--boot-spec",
          specPath,
          "--relay-uid",
          "987",
        ]);
        expect(res.status, `expected failure for ${testCase.name}`).not.toBe(0);
      }
    });
  });

  describe("Account egress validation parity with packages/browser-runtime-core/src/browser-egress-upstream.ts", () => {
    it("matches parseBrowserEgressUpstreamUrl on every valid and invalid URL case", () => {
      const urlCases: Array<{ url: string; expectedValid: boolean }> = [
        { url: "https://proxy.example.test:8443", expectedValid: true },
        { url: "https://proxy.example.test:443", expectedValid: true },
        { url: "https://203.0.113.10:3128", expectedValid: true },
        { url: "https://[2001:db8::1]:8443", expectedValid: true },
        { url: "  https://proxy.example.test:8443  ", expectedValid: true },
        {
          url: `https://${"a".repeat(60)}.${"b".repeat(60)}.example.test:8443`,
          expectedValid: true,
        },
        { url: `https://${"a".repeat(1000)}.example.test:8443`, expectedValid: false },
        { url: "", expectedValid: false },
        { url: "   ", expectedValid: false },
        { url: "https://proxy.example.test", expectedValid: false },
        { url: "https://proxy.example.test:0", expectedValid: false },
        { url: "https://proxy.example.test:65536", expectedValid: false },
        { url: "https://proxy.example.test:8443/", expectedValid: false },
        { url: "https://proxy.example.test:8443/path", expectedValid: false },
        { url: "https://proxy.example.test:8443?foo=bar", expectedValid: false },
        { url: "https://proxy.example.test:8443#frag", expectedValid: false },
        { url: "https://user:pass@proxy.example.test:8443", expectedValid: false },
        { url: "http://proxy.example.test:8443", expectedValid: false },
        { url: "socks5://proxy.example.test:1080", expectedValid: false },
        { url: "https://proxy.example.test:abc", expectedValid: false },
        { url: `https://${"a".repeat(1020)}.example.test:8443`, expectedValid: false },
      ];

      for (const { url, expectedValid } of urlCases) {
        const accountRes = validateEgressUpstreamUrl(url);
        const runtimeRes = parseBrowserEgressUpstreamUrl(url);
        expect(accountRes.ok, `account validation mismatch for ${JSON.stringify(url)}`).toBe(
          expectedValid,
        );
        expect(Boolean(runtimeRes), `runtime validation mismatch for ${JSON.stringify(url)}`).toBe(
          expectedValid,
        );
        if (accountRes.ok) {
          expect(parseBrowserEgressUpstreamUrl(accountRes.value)).toBeDefined();
        }
      }
    });

    it("matches browserEgressCredentialWritable on every valid and invalid username and password case", () => {
      const credentialCases: Array<{
        kind: "username" | "password";
        value: string;
        expectedValid: boolean;
      }> = [
        { kind: "username", value: "egress-user", expectedValid: true },
        { kind: "username", value: "u".repeat(1024), expectedValid: true },
        { kind: "password", value: "p@ss:word! #1", expectedValid: true },
        { kind: "password", value: "p".repeat(1024), expectedValid: true },
        { kind: "username", value: "", expectedValid: false },
        { kind: "username", value: "   ", expectedValid: false },
        { kind: "username", value: "user:name", expectedValid: false },
        { kind: "username", value: "u".repeat(1025), expectedValid: false },
        { kind: "username", value: "user\nname", expectedValid: false },
        { kind: "username", value: "user\tname", expectedValid: false },
        { kind: "username", value: "user\x7fname", expectedValid: false },
        { kind: "password", value: "", expectedValid: false },
        { kind: "password", value: "   ", expectedValid: false },
        { kind: "password", value: "p".repeat(1025), expectedValid: false },
        { kind: "password", value: "pass\rword", expectedValid: false },
        { kind: "password", value: "pass\nword", expectedValid: false },
        { kind: "password", value: "pass\x00word", expectedValid: false },
        { kind: "password", value: "pass\x7fword", expectedValid: false },
      ];

      for (const { kind, value, expectedValid } of credentialCases) {
        const accountRes = validateEgressCredential(value, kind);
        const runtimeRes = browserEgressCredentialWritable(value, kind);
        expect(
          accountRes.ok,
          `account ${kind} validation mismatch for ${JSON.stringify(value)}`,
        ).toBe(expectedValid);
        expect(runtimeRes, `runtime ${kind} validation mismatch for ${JSON.stringify(value)}`).toBe(
          expectedValid,
        );
      }
    });
  });
});
