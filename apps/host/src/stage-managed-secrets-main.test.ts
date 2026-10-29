import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { stageManagedSecrets } from "./stage-managed-secrets-main.js";

const names = [
  "account-bundle.json",
  "browser-profile.key",
  "credential.key",
  "host-private.pem",
  "host-public.pem",
  "portablefs-ca.pem",
  "portablefs-client.pem",
  "portablefs-client-key.pem",
  "portablefs-product.pem",
] as const;

describe("managed secret staging", () => {
  it("follows Kubernetes projected-secret links and writes only private regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-stage-secrets-"));
    const source = join(root, "source");
    const revision = join(source, "..data-test");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(revision);
    for (const name of names) {
      await writeFile(join(revision, name), `secret-${name}`);
      await symlink(join("..data-test", name), join(source, name));
    }

    await stageManagedSecrets(source, destination);

    for (const name of names) {
      expect(await readFile(join(destination, name), "utf8")).toBe(`secret-${name}`);
      const metadata = await stat(join(destination, name));
      expect(metadata.isFile()).toBe(true);
      if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
    }
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o700);
    }
  });
});
