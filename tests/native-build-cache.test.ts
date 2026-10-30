import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  hashNativeInputs,
  nativeBuildProducts,
  nativeBuildRecipeInputs,
  nativeToolchainIdentity,
  verifyNativeProducts,
} from "../apps/desktop/scripts/native-build-cache.js";

it("checks the exact universal architecture set using the release verifier's lipo archs protocol", async () => {
  let output = "x86_64 arm64";
  const run = async (executable: string, args: readonly string[]) => {
    expect(executable).toBe("/usr/bin/lipo");
    expect(args).toEqual(["-archs", "/fixture/helper"]);
    return output;
  };
  await verifyNativeProducts({ Helper: "/fixture/helper" }, ["arm64", "x86_64"], run);
  output = "arm64";
  await expect(
    verifyNativeProducts({ Helper: "/fixture/helper" }, ["arm64", "x86_64"], run),
  ).rejects.toThrow("architectures");
});

it("binds every reviewed toolchain identity without reading SDK contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-toolchain-identity-"));
  try {
    const source = path.join(root, "main.swift");
    await writeFile(source, "unchanged");
    const values = {
      xcode: "Xcode 27.1\nBuild version 27A9275",
      sdkVersion: "27.1",
      sdkBuild: "27A9275",
      swift: "Apple Swift version 6.3",
      developerDirectory: root,
    };
    const run = async (executable: string, args: readonly string[]) => {
      if (executable === "/usr/bin/xcode-select") return values.developerDirectory;
      if (executable === "/usr/bin/xcodebuild") return values.xcode;
      if (executable === "/usr/bin/swift") return values.swift;
      if (executable === "/usr/bin/xcrun" && args.includes("--show-sdk-version"))
        return values.sdkVersion;
      if (executable === "/usr/bin/xcrun" && args.includes("--show-sdk-build-version"))
        return values.sdkBuild;
      throw Error("Unexpected toolchain command");
    };
    const proof = async () =>
      hashNativeInputs([{ name: "source", path: source }], await nativeToolchainIdentity(run, {}));
    const first = await proof();
    expect((await proof()).digest).toBe(first.digest);
    for (const key of ["xcode", "sdkVersion", "sdkBuild", "swift"] as const) {
      values[key] += "-changed";
      expect((await proof()).digest).not.toBe(first.digest);
      values[key] = first.settings[key]!;
    }
    const alternate = path.join(root, "other-developer");
    await mkdir(alternate);
    values.developerDirectory = alternate;
    expect((await proof()).digest).not.toBe(first.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("hashes SDK-style ancestor links once while rejecting undeclared referents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-native-links-"));
  try {
    const source = path.join(root, "sdk");
    await mkdir(source);
    await writeFile(path.join(source, "header.h"), "original");
    await symlink(".", path.join(source, "ancestor"));
    const hash = () => hashNativeInputs([{ name: "sdk", path: source }], {});
    const first = await hash();
    expect((await hash()).digest).toBe(first.digest);
    await writeFile(path.join(source, "header.h"), "changed");
    expect((await hash()).digest).not.toBe(first.digest);
    await symlink("..", path.join(source, "outside"));
    await expect(hash()).rejects.toThrow("Undeclared native input link");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reuses verified compiler products and rebuilds on source, toolchain, flag, identity or payload changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-native-cache-"));
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "main.swift"), "original");
    const cache = path.join(root, "cache");
    let builds = 0;
    const settings = { toolchain: "compiler-a", flags: "universal", identity: "signer-a" };
    const options = {
      kind: "computer-use" as const,
      names: ["ComputerUseHelper"],
      cacheDirectory: cache,
      sourceRevision: "a".repeat(40),
      inputs: () => hashNativeInputs([{ name: "sources", path: source }], settings),
      build: async () => {
        const file = path.join(root, `product-${++builds}`);
        await writeFile(file, "compiled");
        return { ComputerUseHelper: file };
      },
      verify: async (files: Readonly<Record<string, string>>) => {
        expect(await readFile(files.ComputerUseHelper!, "utf8")).toBe("compiled");
      },
      packageAndVerify: async (files: Readonly<Record<string, string>>) => {
        expect(await readFile(files.ComputerUseHelper!, "utf8")).toBe("compiled");
      },
    };
    expect((await nativeBuildProducts(options)).hit).toBe(false);
    const hit = await nativeBuildProducts(options);
    expect(hit.hit).toBe(true);
    expect(builds).toBe(1);
    for (const key of ["toolchain", "flags", "identity"] as const) {
      settings[key] += "-changed";
      expect((await nativeBuildProducts(options)).hit).toBe(false);
    }
    await writeFile(path.join(source, "main.swift"), "changed");
    expect((await nativeBuildProducts(options)).hit).toBe(false);
    const proof = await options.inputs();
    await writeFile(
      path.join(cache, "computer-use", proof.digest, "ComputerUseHelper"),
      "tampered",
    );
    expect((await nativeBuildProducts(options)).hit).toBe(false);
    expect(builds).toBe(6);
    const failedCache = {
      ...options,
      inputs: async () => {
        throw Error("cache unavailable");
      },
    };
    expect((await nativeBuildProducts(failedCache)).hit).toBe(false);
    expect(builds).toBe(7);
    await writeFile(path.join(source, "main.swift"), "not-yet-verified");
    await expect(
      nativeBuildProducts({
        ...options,
        packageAndVerify: async () => {
          throw Error("signed bundle verification failed");
        },
      }),
    ).rejects.toThrow("signed bundle verification failed");
    const unverified = await options.inputs();
    await expect(
      readFile(path.join(cache, "computer-use", unverified.digest, "record.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await nativeBuildProducts(options)).hit).toBe(false);
    expect((await nativeBuildProducts(options)).hit).toBe(true);
    expect(builds).toBe(9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("invalidates both helper recipes when only the shared Swift builder changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-shared-builder-"));
  try {
    const recipes = (["computer-use", "passwords"] as const).map((kind) =>
      nativeBuildRecipeInputs(root, kind),
    );
    for (const file of new Set(recipes.flatMap((roots) => roots.map((entry) => entry.path)))) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "original");
    }
    const before = await Promise.all(recipes.map((roots) => hashNativeInputs(roots, {})));
    await writeFile(
      path.join(root, "apps/desktop/scripts/build-swift-products.ts"),
      "changed compiler flags",
    );
    for (const [index, roots] of recipes.entries())
      expect((await hashNativeInputs(roots, {})).digest).not.toBe(before[index]!.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
