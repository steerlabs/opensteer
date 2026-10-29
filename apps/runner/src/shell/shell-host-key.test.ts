import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareShellModule } from "./shell-host-key.js";

const canonicalHostKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("shell module preparation", () => {
  it("advertises only supported platforms with an executable helper", async () => {
    const directory = await temporaryDirectory();
    const helper = join(directory, "helper");
    await writeFile(helper, "#!/bin/sh\nexit 0\n");
    await chmod(helper, 0o700);
    const runKeygen = vi.fn(async () => canonicalHostKey);
    const probe = vi.fn(async () => true);

    await expect(
      prepareShellModule({
        dataDirectory: directory,
        helperBinary: helper,
        platform: "darwin",
        probeFullDiskAccess: probe,
        runKeygen,
      }),
    ).resolves.toMatchObject({
      descriptor: { fullDiskAccess: true, platform: "darwin", hostPublicKey: canonicalHostKey },
    });
    const linux = await prepareShellModule({
      dataDirectory: directory,
      helperBinary: helper,
      platform: "linux",
      probeFullDiskAccess: probe,
      runKeygen,
    });
    expect(linux?.descriptor).toEqual({ hostPublicKey: canonicalHostKey, platform: "linux" });
    // Linux has no such gate, so the key is absent rather than false: the Host
    // tells "no gate exists" from "the gate is closed" by that absence alone.
    expect(linux?.descriptor).not.toHaveProperty("fullDiskAccess");
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(
      prepareShellModule({
        dataDirectory: directory,
        helperBinary: helper,
        platform: "win32",
        probeFullDiskAccess: probe,
        runKeygen,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses to advertise shell when the macOS full access probe fails", async () => {
    const directory = await temporaryDirectory();
    const helper = join(directory, "helper");
    await writeFile(helper, "#!/bin/sh\nexit 0\n");
    await chmod(helper, 0o700);

    await expect(
      prepareShellModule({
        dataDirectory: directory,
        helperBinary: helper,
        platform: "darwin",
        probeFullDiskAccess: async () => {
          throw new Error("the helper is broken");
        },
        runKeygen: async () => canonicalHostKey,
      }),
    ).rejects.toThrow("the helper is broken");
  });

  it("does not advertise when the helper is absent", async () => {
    const directory = await temporaryDirectory();
    await expect(
      prepareShellModule({
        dataDirectory: directory,
        helperBinary: join(directory, "missing"),
        platform: "linux",
      }),
    ).resolves.toBeUndefined();
  });

  it("requires shell-keygen to print the generated public key", async () => {
    const directory = await temporaryDirectory();
    const helper = join(directory, "helper");
    await writeFile(
      helper,
      "#!/bin/sh\nprintf '%s\\n' 'ssh-ed25519 ignored-file-fallback' > \"$3/shell_host_ed25519.pub\"\n",
    );
    await chmod(helper, 0o700);

    await expect(
      prepareShellModule({
        dataDirectory: directory,
        helperBinary: helper,
        platform: "linux",
      }),
    ).rejects.toThrow("did not print its shell host public key");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-shell-key-test-"));
  directories.push(directory);
  return directory;
}
