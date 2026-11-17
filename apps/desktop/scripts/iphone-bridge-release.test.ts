import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "iphone-release-")));
  roots.push(directory);
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  const binary = path.join(directory, "opensteer-iphone-bridge");
  writeFileSync(binary, bytes, { mode: 0o755 });
  const manifest = {
    schemaVersion: 1,
    operatingSystem: "darwin",
    architecture: "arm64",
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
    protocolVersion: 1,
  };
  const writeManifest = (value: unknown) =>
    writeFileSync(path.join(directory, "release.json"), JSON.stringify(value));
  writeManifest(manifest);
  return { directory, binary, bytes, manifest, writeManifest };
}
function verifier() {
  return require("./iphone-bridge-release.cjs") as {
    verifyIphoneBridgeRelease(
      directory: string,
      options: { architecture: string; release: boolean; teamId?: string },
    ): unknown;
  };
}
it.skipIf(process.platform === "win32")(
  "pins a strict bridge manifest to an executable of the package architecture",
  () => {
    const f = fixture();
    const verify = () =>
      verifier().verifyIphoneBridgeRelease(f.directory, { architecture: "arm64", release: false });
    expect(verify()).toEqual(f.manifest);
    for (const change of [
      { protocolVersion: 2 },
      { extra: true },
      { architecture: "amd64" },
      { binarySha256: "a".repeat(64) },
    ]) {
      f.writeManifest({ ...f.manifest, ...change });
      expect(verify).toThrow();
    }
    f.writeManifest(f.manifest);
    expect(() =>
      verifier().verifyIphoneBridgeRelease(f.directory, { architecture: "amd64", release: false }),
    ).toThrow();
    writeFileSync(f.binary, Buffer.concat([f.bytes, Buffer.from("tampered")]));
    expect(verify).toThrow();
    writeFileSync(f.binary, f.bytes);
    chmodSync(f.binary, 0o644);
    expect(verify).toThrow();
    rmSync(f.binary);
    expect(verify).toThrow();
  },
);
it.skipIf(process.platform === "win32")(
  "requires the bridge Developer ID, hardened runtime, timestamp and no entitlements",
  () => {
    const f = fixture();
    let detail =
      "Identifier=com.opensteer.iphone-bridge\nTeamIdentifier=B47U2LLKHW\nAuthority=Developer ID Application: Fixture\nCodeDirectory v=20500 flags=0x10000(runtime)\nTimestamp=fixture\n";
    let entitlements = "";
    vi.spyOn(childProcess, "spawnSync").mockImplementation(() => ({
      status: 0,
      stdout: detail,
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    }));
    vi.spyOn(childProcess, "execFileSync").mockImplementation((_file, args) => {
      const argv = args as string[];
      if (argv.includes("--verbose=4")) return detail;
      if (argv.includes("--entitlements")) return entitlements;
      if (argv.includes("plutil") || argv.includes("json"))
        return '{"com.apple.security.cs.allow-jit":true}';
      return "";
    });
    const verify = () =>
      verifier().verifyIphoneBridgeRelease(f.directory, {
        architecture: "arm64",
        release: true,
        teamId: "B47U2LLKHW",
      });
    expect(verify()).toEqual(f.manifest);
    for (const line of [
      "Identifier=com.opensteer.iphone-bridge",
      "TeamIdentifier=B47U2LLKHW",
      "Authority=Developer ID Application: Fixture",
      "CodeDirectory v=20500 flags=0x10000(runtime)",
      "Timestamp=fixture",
    ]) {
      const valid = detail;
      detail = detail.replace(line, "");
      expect(verify).toThrow();
      detail = valid;
    }
    entitlements = "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>";
    expect(verify).toThrow();
  },
);
