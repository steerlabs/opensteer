import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bundledIphoneBridgePath, verifyIphoneBridge } from "./bridge-paths.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.skipIf(process.platform === "win32")(
  "verifies the exact packaged resource and rejects digest, architecture and symlink substitutions",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "opensteer-iphone-path-")));
    roots.push(root);
    const binary = path.join(root, "opensteer-iphone-bridge");
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
    await writeFile(binary, bytes, { mode: 0o700 });
    const manifest = {
      schemaVersion: 1,
      operatingSystem: "darwin",
      architecture: "arm64",
      protocolVersion: 1,
      binarySha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(path.join(root, "release.json"), JSON.stringify(manifest));
    const verifySignature = vi.fn(async () => undefined);
    await expect(
      verifyIphoneBridge({ binary, packaged: true, arch: "arm64", verifySignature }),
    ).resolves.toBe(binary);
    expect(verifySignature.mock.calls[0]).toEqual([
      binary,
      expect.stringContaining("com.opensteer.iphone-bridge"),
    ]);
    await expect(
      verifyIphoneBridge({ binary, packaged: true, arch: "x64", verifySignature }),
    ).rejects.toMatchObject({ code: "bridge-signature-invalid" });
    await writeFile(binary, Buffer.concat([bytes, Buffer.from("modified")]));
    await expect(
      verifyIphoneBridge({ binary, packaged: true, arch: "arm64", verifySignature }),
    ).rejects.toMatchObject({ code: "bridge-signature-invalid" });
    const link = path.join(root, "linked");
    await symlink(binary, link);
    await expect(
      verifyIphoneBridge({ binary: link, packaged: true, arch: "arm64", verifySignature }),
    ).rejects.toMatchObject({ code: "bridge-signature-invalid" });
    expect(
      bundledIphoneBridgePath({ packaged: true, resourcesPath: root, developmentRoot: "/ignored" }),
    ).toBe(path.join(root, "iphone-bridge", "opensteer-iphone-bridge"));
  },
);

it.skipIf(process.platform === "win32")(
  "resolves and validates each development architecture without a release manifest",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "opensteer-iphone-dev-")));
    roots.push(root);
    for (const arch of ["arm64", "x64"] as const) {
      const binary = bundledIphoneBridgePath({ packaged: false, developmentRoot: root, arch });
      expect(binary).toBe(
        path.join(
          root,
          "apps/desktop/generated-native",
          `darwin-${arch === "x64" ? "amd64" : arch}`,
          "opensteer-iphone-bridge",
        ),
      );
      await mkdir(path.dirname(binary), { recursive: true });
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
      await writeFile(binary, bytes, { mode: 0o700 });
      await expect(verifyIphoneBridge({ binary, packaged: false, arch })).resolves.toBe(binary);
      await expect(
        verifyIphoneBridge({ binary, packaged: false, arch: arch === "arm64" ? "x64" : "arm64" }),
      ).rejects.toMatchObject({ code: "bridge-not-built" });
    }
  },
);
