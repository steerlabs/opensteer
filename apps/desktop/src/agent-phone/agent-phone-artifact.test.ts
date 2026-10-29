/**
 * Packaging failures, written before enforcing APK build provenance: a release
 * package carries a debug APK or none at all; the after-pack check admits an
 * old manifest without a build type; or ordinary development packages
 * unnecessarily reject their matching debug artifacts.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBundledAgentPhoneArtifact } from "./agent-phone-artifact.js";

const require = createRequire(import.meta.url);
const afterPack = require("../../scripts/after-pack.cjs") as {
  verifyAgentPhone(resources: string, required: boolean): void;
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(buildType: "debug" | "release" | null) {
  const resources = await mkdtemp(join(tmpdir(), "opensteer-phone-release-"));
  directories.push(resources);
  const directory = join(resources, "agent-phone");
  await mkdir(directory);
  const bytes = Buffer.from("APK fixture bytes");
  const manifest = {
    apkSha256: createHash("sha256").update(bytes).digest("hex"),
    apkSize: bytes.length,
    ...(buildType ? { buildType } : {}),
    minSdk: 30,
    packageName: "com.opensteer.agentphone",
    signingCertSha256: "a".repeat(64),
    versionCode: 117,
    versionName: "0.1.117",
  };
  await writeFile(join(directory, "opensteer-agent-phone.apk"), bytes);
  await writeFile(join(directory, "agent-phone.json"), JSON.stringify(manifest));
  return { directory, resources };
}

it.each(["debug", "release"] as const)(
  "development can read and package a matching %s artifact",
  async (type) => {
    const { directory, resources } = await fixture(type);
    expect(await readBundledAgentPhoneArtifact(directory)).not.toBeNull();
    expect(() => afterPack.verifyAgentPhone(resources, false)).not.toThrow();
  },
);

it("after-pack refuses a release package without the artifact", async () => {
  const resources = await mkdtemp(join(tmpdir(), "opensteer-phone-release-"));
  directories.push(resources);
  expect(() => afterPack.verifyAgentPhone(resources, true)).toThrow(/missing/u);
});

it("after-pack rejects a matching debug APK for a release", async () => {
  const { resources } = await fixture("debug");
  expect(() => afterPack.verifyAgentPhone(resources, true)).toThrow(/release/u);
});

it("after-pack rejects a manifest that does not identify its build type", async () => {
  const { resources } = await fixture(null);
  expect(() => afterPack.verifyAgentPhone(resources, true)).toThrow();
});
