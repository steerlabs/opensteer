import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCachedPhone, phoneCacheInputs } from "../scripts/release-phone-cache.js";
import { runBounded } from "../scripts/command-runner.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = realpathSync(
    await mkdtemp(
      path.join(process.env.OPENSTEER_PHONE_CACHE_EVIDENCE_DIRECTORY ?? tmpdir(), "phone-cache-"),
    ),
  );
  const source = path.join(root, "source");
  const sdk = path.join(root, "sdk");
  const jdk = path.join(root, "jdk");
  const state = path.join(root, "state");
  const cache = path.join(root, "cache");
  for (const p of [source, sdk, jdk, state, cache]) await mkdir(p);
  const write = async (name: string, value = name) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
  };
  await write("source/package.json", '{"version":"1.2.3"}');
  await write("source/app.kt");
  for (const name of [
    "platforms/android-36/android.jar",
    "build-tools/36.0.0/aapt2",
    "build-tools/36.0.0/apksigner",
    "build-tools/36.0.0/lib/apksigner.jar",
    "build-tools/36.0.0/lib/d8.jar",
    "build-tools/36.0.0/zipalign",
  ])
    await write("sdk/" + name);
  for (const name of ["bin/java", "bin/javac", "lib/modules", "release"])
    await write("jdk/" + name);
  await write("key.p12");
  const git = (args: string[]) => runBounded("git", args, { cwd: source });
  await git(["init", "-q"]);
  await git(["config", "user.name", "Cache fixture"]);
  await git(["config", "user.email", "cache@example.invalid"]);
  await git(["config", "core.hooksPath", "/dev/null"]);
  await git(["add", "."]);
  await git(["commit", "-qm", "candidate"]);
  const identity = { sourceRevision: await git(["rev-parse", "HEAD"]), version: "1.2.3" };
  const config = {
    sdkDirectory: sdk,
    keystorePath: path.join(root, "key.p12"),
    keyAlias: "release",
    keychainService: "fixture",
  };
  const context = {
    sourceDirectory: source,
    artifactDirectory: path.join(root, "delivery"),
    identity,
    signal: new AbortController().signal,
    run: async (
      command: string,
      args: readonly string[],
      options: Parameters<typeof runBounded>[2],
    ) => (command === "sh" ? `java.home = ${jdk}` : runBounded(command, args, options)),
  };
  let builds = 0;
  const events: string[] = [];
  const options = {
    config,
    context,
    cache,
    state,
    log: (line: string) => events.push(line),
    build: async () => {
      builds++;
      await mkdir(context.artifactDirectory, { recursive: true });
      for (const name of [
        "opensteer-agent-phone.apk",
        "agent-phone.json",
        "agent-phone-release.json",
      ])
        await writeFile(
          path.join(context.artifactDirectory, name),
          name === "agent-phone-release.json" ? JSON.stringify({ fixture: true }) : name,
        );
      return hash(JSON.stringify({ fixture: true }));
    },
    verify: async (directory: string, receipt: string) => {
      expect(hash(await readFile(path.join(directory, "agent-phone-release.json"), "utf8"))).toBe(
        receipt,
      );
      expect(await readFile(path.join(directory, "opensteer-agent-phone.apk"), "utf8")).toBe(
        "opensteer-agent-phone.apk",
      );
    },
  };
  return {
    root,
    source,
    sdk,
    jdk,
    state,
    cache,
    write,
    git,
    config,
    context,
    options,
    events,
    builds: () => builds,
  };
}

describe("signed phone cache provider journey", () => {
  it("reuses identical inputs without invoking a builder", async () => {
    const f = await fixture();
    const first = await prepareCachedPhone(f.options);
    await rm(f.context.artifactDirectory, { recursive: true });
    expect(await prepareCachedPhone(f.options)).toBe(first);
    expect(f.builds()).toBe(1);
    await writeFile(
      path.join(f.root, "journey.json"),
      JSON.stringify({ events: f.events, builds: f.builds() }),
    );
    console.log(`Phone cache artifact: ${f.root}/journey.json`);
  });

  const changedFiles = [
    "sdk/platforms/android-36/android.jar",
    "sdk/build-tools/36.0.0/aapt2",
    "sdk/build-tools/36.0.0/lib/d8.jar",
    "sdk/build-tools/36.0.0/lib/apksigner.jar",
    "sdk/build-tools/36.0.0/zipalign",
    "jdk/lib/modules",
    "jdk/bin/java",
    "key.p12",
  ];
  for (const file of changedFiles)
    it(`rebuilds when ${file} changes`, async () => {
      const f = await fixture();
      await prepareCachedPhone(f.options);
      await f.write(file, "changed");
      await prepareCachedPhone(f.options);
      expect(f.builds()).toBe(2);
      await writeFile(
        path.join(f.root, "journey.json"),
        JSON.stringify({ file, events: f.events, builds: f.builds() }),
      );
    });
  for (const variant of ["signing alias", "new SHA"] as const)
    it(`never reuses across ${variant}`, async () => {
      const f = await fixture();
      await prepareCachedPhone(f.options);
      if (variant === "signing alias") f.config.keyAlias = "other";
      else {
        await f.git(["commit", "--allow-empty", "-qm", "new SHA"]);
        f.context.identity.sourceRevision = await f.git(["rev-parse", "HEAD"]);
      }
      await prepareCachedPhone(f.options);
      expect(f.builds()).toBe(2);
      await writeFile(
        path.join(f.root, "journey.json"),
        JSON.stringify({ variant, events: f.events, builds: f.builds() }),
      );
    });

  for (const poison of ["tamper", "partial", "staging", "symlink"] as const)
    it(`reports ${poison} and rebuilds privately without overwriting the poisoned slot`, async () => {
      const f = await fixture();
      await prepareCachedPhone(f.options);
      const directory = path.join(f.cache, f.context.identity.sourceRevision);
      const key = (await readdir(directory)).find((name) => /^[a-f0-9]{64}$/.test(name))!;
      const entry = path.join(directory, key);
      if (poison === "tamper")
        await writeFile(path.join(entry, "agent-phone/opensteer-agent-phone.apk"), "poison");
      if (poison === "partial") await rm(path.join(entry, "phone-manifest.json"));
      if (poison === "staging") await rename(entry, entry + ".partial-crash");
      if (poison === "symlink") {
        await rm(path.join(entry, "agent-phone"), { recursive: true });
        await symlink(f.context.artifactDirectory, path.join(entry, "agent-phone"));
      }
      await prepareCachedPhone(f.options);
      expect(f.builds()).toBe(2);
      expect(f.events.join("\n")).toMatch(/poison/i);
      if (poison === "tamper")
        expect(
          await readFile(path.join(entry, "agent-phone/opensteer-agent-phone.apk"), "utf8"),
        ).toBe("poison");
      if (poison === "partial")
        await expect(readFile(path.join(entry, "phone-manifest.json"))).rejects.toThrow();
    });

  it("does not seal signing failures or input drift", async () => {
    const f = await fixture();
    await expect(
      prepareCachedPhone({
        ...f.options,
        build: async () => {
          throw new Error("signing failed");
        },
      }),
    ).rejects.toThrow("signing failed");
    await expect(
      prepareCachedPhone({
        ...f.options,
        build: async () => {
          const digest = await f.options.build();
          await f.write("jdk/lib/modules", "drift");
          return digest;
        },
      }),
    ).rejects.toThrow(/inputs changed/i);
  });

  it("never accepts an unanchored receipt", async () => {
    const f = await fixture();
    await prepareCachedPhone(f.options);
    await rm(path.join(f.state, "candidate-phone-ledger"), { recursive: true });
    await prepareCachedPhone(f.options);
    expect(f.builds()).toBe(2);
    expect(f.events.join("\n")).toMatch(/poison/i);
  });

  it("hashes tracked source and refuses dirty/unknown inputs", async () => {
    const f = await fixture();
    const before = await phoneCacheInputs(f.config, f.context);
    await f.write("source/app.kt", "dirty");
    await expect(phoneCacheInputs(f.config, f.context)).rejects.toThrow(/clean|source/i);
    await f.git(["add", "."]);
    await f.git(["commit", "-qm", "changed"]);
    f.context.identity.sourceRevision = await f.git(["rev-parse", "HEAD"]);
    expect(await phoneCacheInputs(f.config, f.context)).not.toEqual(before);
  });
});
