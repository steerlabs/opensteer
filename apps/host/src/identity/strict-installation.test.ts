import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { loadHostKeys } from "./host-keys.js";
import { loadHostInstance } from "./host-instance.js";

it("strict installation loading fails for missing files and never creates or chmods them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "strict-installation-"));
  try {
    const privateKeyPath = join(directory, "private"),
      publicKeyPath = join(directory, "public"),
      path = join(directory, "instance");
    await expect(loadHostKeys({ privateKeyPath, publicKeyPath })).rejects.toThrow();
    await expect(loadHostInstance(path)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    const keys = generateKeyPairSync("ed25519");
    const id = createId("hostInstance");
    await writeFile(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o444,
    });
    await writeFile(publicKeyPath, keys.publicKey.export({ format: "pem", type: "spki" }), {
      mode: 0o444,
    });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, hostInstanceId: id }), {
      mode: 0o444,
    });
    await loadHostKeys({ privateKeyPath, publicKeyPath });
    expect((await loadHostInstance(path)).hostInstanceId).toBe(id);
    for (const file of [path, privateKeyPath, publicKeyPath])
      expect((await stat(file)).mode & 0o777).toBe(0o444);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
