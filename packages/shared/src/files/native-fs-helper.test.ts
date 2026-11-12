import { afterEach, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeFsHelper } from "./native-fs-helper.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function helper(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-files-test-"));
  directories.push(directory);
  const binary = join(directory, "helper");
  await writeFile(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { directory, binary, helper: new NativeFsHelper({ binary, rootPolicy: "managed-local" }) };
}
it("refuses symlinked and writable helper executables before running them", async () => {
  const fixture = await helper("process.exit(99)");
  const link = join(fixture.directory, "link");
  await symlink(fixture.binary, link);
  await expect(
    new NativeFsHelper({ binary: link }).read(
      { root: "/tmp", path: "x" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("not trusted");
  await chmod(fixture.binary, 0o722);
  await expect(
    fixture.helper.read({ root: "/tmp", path: "x" }, new AbortController().signal),
  ).rejects.toThrow("not trusted");
});
it("bounds request and response bytes and rejects a false containment claim", async () => {
  const fixture = await helper('process.stdout.write("x".repeat(2*1024*1024+1));');
  await expect(
    fixture.helper.read(
      { root: "/tmp", path: "x".repeat(3 * 1024 * 1024) },
      new AbortController().signal,
    ),
  ).rejects.toThrow("request exceeds its byte limit");
  await expect(
    fixture.helper.read({ root: "/tmp", path: "x" }, new AbortController().signal),
  ).rejects.toThrow("response exceeds its byte limit");
  const otherPlatform = process.platform === "darwin" ? "linux" : "darwin";
  const lying = await helper(
    `process.stdout.write(JSON.stringify({binaryIdentity:"opensteer-native-fs",binaryVersion:"1.6.0",platform:${JSON.stringify(otherPlatform)},containment:${JSON.stringify(otherPlatform === "linux" ? "linux-openat2" : "posix-openat-nofollow")},ok:true,result:{contentBase64:"eA==",path:"x",size:1}}));`,
  );
  await expect(
    lying.helper.read({ root: "/tmp", path: "x" }, new AbortController().signal),
  ).rejects.toThrow("containment is unavailable");
});
