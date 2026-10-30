import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildSignedMac, type MacContext } from "../scripts/release-beta-mac.js";
import { signedMacHelpers } from "../scripts/signed-mac-helpers.js";

vi.mock("../apps/desktop/scripts/personal-runtime-provenance.js", () => ({
  readProvenPersonalRuntime: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../scripts/release-agent-phone.js", () => ({
  stageAgentPhoneRelease: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => vi.unstubAllEnvs());

it("builds each signed helper before packaging a prebuilt Personal runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "signed-mac-test-"));
  try {
    const keychain = path.join(root, "test.keychain-db");
    await writeFile(keychain, "");
    const identity = "Developer ID Application: Test (ABCDEFGHIJ)";
    vi.stubEnv("OPENSTEER_DESKTOP_SIGNING_FILE", "");
    vi.stubEnv("OPENSTEER_RELEASE_SIGNING_IDENTITY", identity);
    vi.stubEnv("OPENSTEER_APPLE_TEAM_ID", "ABCDEFGHIJ");
    vi.stubEnv("CSC_KEYCHAIN", keychain);
    const commands: {
      executable: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv | undefined;
    }[] = [];
    const stopped = new Error("packaging reached");
    const run: MacContext["run"] = async (executable, args, options) => {
      commands.push({ executable, args, env: options.env });
      if (args.includes("package:mac")) throw stopped;
      return executable === "/usr/bin/xcrun" ? "26.3" : "";
    };
    const binary = { path: path.join(root, "tool"), sha256: "a".repeat(64), version: "1" };
    const config: Parameters<typeof buildSignedMac>[0] = {
      architecture: "arm64",
      signingIdentity: identity,
      keychain,
      passwordsProvisioningProfile: path.join(root, "profile"),
      personalRuntimeSource: path.join(root, "runtime"),
      supervisor: binary,
      cloudflared: binary,
      targets: [
        {
          id: "local",
          stagingDirectory: path.join(root, "stage"),
          applicationPath: path.join(root, "Opensteer Beta.app"),
          runtimeStatusUrl: "http://localhost/healthz",
        },
      ],
    };
    const context: MacContext = {
      sourceDirectory: process.cwd(),
      stateDirectory: root,
      identity: { sourceRevision: "a".repeat(40), version: "1.2.3" },
      agentPhoneArtifactDirectory: path.join(root, "phone"),
      agentPhoneReceiptSha256: "b".repeat(64),
      agentPhoneSigning: {
        sdkDirectory: root,
        keystorePath: path.join(root, "keystore"),
        keyAlias: "test",
        keychainService: "test",
      },
      signal: new AbortController().signal,
      run,
    };
    await expect(buildSignedMac(config, context)).rejects.toBe(stopped);
    const packaging = commands.findIndex((command) => command.args.includes("package:mac"));
    expect(packaging).toBeGreaterThan(0);
    for (const script of [
      "build-computer-use-helper.ts",
      ...signedMacHelpers.map((helper) => helper.script),
    ]) {
      const index = commands.findIndex((command) => command.args.includes(`scripts/${script}`));
      expect(index, `${script} must run before packaging`).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(packaging);
      const command = commands[index]!;
      expect(command.executable).toBe("pnpm");
      expect(command.args.slice(-2)).toEqual(["--sign", identity]);
      expect(command.env?.CSC_KEYCHAIN).toBe(keychain);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
