import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  hashNativeInputs,
  nativeBuildProducts,
  nativeBuildRecipeInputs,
  nativeReleaseInputs,
  nativeToolchainIdentity,
  verifyNativeProducts,
} from "../apps/desktop/scripts/native-build-cache.js";

it("checks universal slices and accepts only unsigned or linker ad-hoc products", async () => {
  let output = "x86_64 arm64";
  let signature = "Signature=adhoc\nTeamIdentifier=not set\nstatus=0\n";
  const run = async (executable: string, args: readonly string[]) => {
    if (executable === "/bin/sh") return signature;
    expect(executable).toBe("/usr/bin/lipo");
    expect(args).toEqual(["-archs", "/fixture/helper"]);
    return output;
  };
  await verifyNativeProducts({ Helper: "/fixture/helper" }, ["arm64", "x86_64"], run);
  signature = "code object is not signed at all\nstatus=1\n";
  await verifyNativeProducts({ Helper: "/fixture/helper" }, ["arm64", "x86_64"], run);
  for (const invalid of [
    "Authority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nstatus=0\n",
    "Signature=adhoc\nTeamIdentifier=ABCDE12345\nstatus=0\n",
    "unknown error\nstatus=1\n",
  ]) {
    signature = invalid;
    await expect(
      verifyNativeProducts({ Helper: "/fixture/helper" }, ["arm64", "x86_64"], run),
    ).rejects.toThrow("signature");
  }
  signature = "Signature=adhoc\nTeamIdentifier=not set\nstatus=0\n";
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
      sdkDirectory: root,
      clang: "Apple clang version 18",
      osBuild: "27A9275",
      developerDirectory: root,
    };
    const run = async (executable: string, args: readonly string[]) => {
      if (executable === "/usr/bin/xcode-select") return values.developerDirectory;
      if (executable === "/usr/bin/xcodebuild") return values.xcode;
      if (executable === "/usr/bin/swift") return values.swift;
      if (executable === "/usr/bin/sw_vers") return values.osBuild;
      if (args.includes("--show-sdk-path")) return values.sdkDirectory;
      if (args.includes("clang")) return values.clang;
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
    for (const key of ["xcode", "sdkVersion", "sdkBuild", "swift", "clang", "osBuild"] as const) {
      values[key] += "-changed";
      expect((await proof()).digest).not.toBe(first.digest);
      values[key] = first.settings[key]!;
    }
    const alternate = path.join(root, "other-developer");
    await mkdir(alternate);
    values.sdkDirectory = alternate;
    expect((await proof()).digest).not.toBe(first.digest);
    values.sdkDirectory = root;
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

it("invalidates every helper recipe when only the shared Swift builder changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-shared-builder-"));
  try {
    const recipes = (["computer-use", "passwords", "dictation"] as const).map((kind) =>
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

it("keys each helper by its transitive compiler inputs, independently of unrelated files and signing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-release-inputs-"));
  const kinds = ["computer-use", "passwords", "dictation"] as const;
  const shared = ["macos-signing", "apple-data", "apple-dictation"];
  const directory = (kind: string) => path.join(root, "apps/desktop/native", kind);
  const write = async (file: string, value = "original") => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  };
  try {
    for (const pkg of [
      ...kinds.map(directory),
      ...shared.map((p) => path.join(root, "packages", p)),
    ]) {
      await write(path.join(pkg, "Sources/main.swift"));
      await write(path.join(pkg, "Package.swift"));
      await write(path.join(pkg, "Package.resolved"));
    }
    for (const kind of kinds)
      for (const input of nativeBuildRecipeInputs(root, kind)) await write(input.path);
    const dependencies: Record<string, string[]> = {
      "computer-use": ["macos-signing", "apple-data"],
      passwords: ["macos-signing"],
      dictation: ["macos-signing", "apple-dictation"],
    };
    const run = async (executable: string, args: readonly string[]) => {
      if (args.includes("show-dependencies")) {
        const pkg = args[args.indexOf("--package-path") + 1]!;
        return JSON.stringify({
          path: pkg,
          dependencies: dependencies[path.basename(pkg)]!.map((name) => ({
            path: path.join(root, "packages", name),
            dependencies: [],
          })),
        });
      }
      if (executable === "/usr/bin/xcode-select" || args.includes("--show-sdk-path")) return root;
      return "toolchain-identity";
    };
    const proof = (kind: (typeof kinds)[number], environment = {}) =>
      nativeReleaseInputs(root, kind, ["arm64", "x86_64"], run, environment);
    const keys = async () => Promise.all(kinds.map(async (kind) => (await proof(kind))!.digest));
    const baseline = await keys();
    const changes = [
      ["apps/desktop/native/computer-use/Sources/main.swift", [0]],
      ["apps/desktop/native/passwords/Package.swift", [1]],
      ["packages/macos-signing/Package.resolved", [0, 1, 2]],
      ["packages/apple-dictation/Sources/main.swift", [2]],
      ["packages/apple-data/Sources/OpensteerAppleData/Resources/contracts.json", [0]],
      ["apps/desktop/native/passwords/Sources/PasswordsCore/Resources/public_suffix_list.dat", [1]],
      ["apps/desktop/native/passwords/Sources/PasswordsImportWorker/Info.plist", [1]],
      ["apps/desktop/native/dictation/.swiftpm/configuration/mirrors.json", [2]],
    ] as const;
    for (const [file, affected] of changes) {
      const before = await keys();
      await write(path.join(root, file), "changed");
      const after = await keys();
      kinds.forEach((_, index) => {
        expect(after[index] === before[index], file).toBe(!affected.some((n) => n === index));
      });
    }
    const beforeUnrelated = await keys();
    for (const file of [
      "packages/client/src/unrelated.ts",
      "apps/web/unrelated.ts",
      "package.json",
    ])
      await write(path.join(root, file));
    expect(await keys()).toEqual(beforeUnrelated);
    const signed = await proof("passwords", {
      OPENSTEER_RELEASE_SIGNING_IDENTITY: "a-new-signer",
      OPENSTEER_PASSWORDS_PROVISIONING_PROFILE: "/must/not/be/read",
      OPENSTEER_SOURCE_REVISION: "b".repeat(40),
      OPENSTEER_RELEASE_VERSION: "99.0.0",
    });
    expect(signed!.digest).toBe(beforeUnrelated[1]);
    expect((await nativeReleaseInputs(root, "computer-use", ["arm64"], run, {}))!.digest).not.toBe(
      beforeUnrelated[0],
    );
    expect(await proof("computer-use", { TOOLCHAINS: "custom" })).toBeUndefined();
    expect(await proof("computer-use", { OPENSTEER_NATIVE_BUILD_CACHE: "off" })).toBeUndefined();
    expect(baseline.every(Boolean)).toBe(true);
    // Newly declared dependencies must join the key without a second hand-maintained list.
    await write(path.join(root, "packages/added/Sources/main.swift"));
    await write(path.join(root, "packages/added/Package.swift"));
    dependencies.passwords!.push("added");
    const added = (await proof("passwords"))!;
    await write(path.join(root, "packages/added/Sources/main.swift"), "changed dependency");
    expect((await proof("passwords"))!.digest).not.toBe(added.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects mismatched, incomplete, linked and corrupt restored entries before packaging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-cache-restore-"));
  try {
    const compilerProduct = path.join(root, "fresh");
    await writeFile(compilerProduct, "compiled");
    let builds = 0;
    let packaged = 0;
    const proof = await hashNativeInputs([{ name: "source", path: compilerProduct }], {});
    const options = {
      kind: "dictation" as const,
      names: ["DictationHelper"],
      cacheDirectory: path.join(root, "cache"),
      sourceRevision: "a".repeat(40),
      inputs: async () => proof,
      build: async () => {
        builds++;
        return { DictationHelper: compilerProduct };
      },
      verify: async (files: Readonly<Record<string, string>>) => {
        expect(await readFile(files.DictationHelper!, "utf8")).toBe("compiled");
      },
      packageAndVerify: async () => {
        packaged++;
      },
    };
    await nativeBuildProducts(options);
    const entry = path.join(options.cacheDirectory, "dictation", proof.digest);
    const saved = path.join(root, "saved");
    await cp(entry, saved, { recursive: true });
    for (const mutation of ["proof", "record", "missing", "link", "payload", "extra"]) {
      await rm(entry, { recursive: true });
      await cp(saved, entry, { recursive: true });
      const product = path.join(entry, "DictationHelper");
      if (mutation === "proof") await writeFile(path.join(entry, "inputs.json"), "{}");
      if (mutation === "record") {
        const record = JSON.parse(await readFile(path.join(entry, "record.json"), "utf8"));
        record.inputDigest = "0".repeat(64);
        await writeFile(path.join(entry, "record.json"), JSON.stringify(record));
      }
      if (mutation === "missing" || mutation === "link") await rm(product);
      if (mutation === "link") await symlink(compilerProduct, product);
      if (mutation === "payload") await writeFile(product, "tampered");
      if (mutation === "extra") await writeFile(path.join(entry, "unexpected"), "extra");
      const before = builds;
      expect((await nativeBuildProducts(options)).hit, mutation).toBe(false);
      expect(builds, mutation).toBe(before + 1);
      expect(packaged).toBe(builds);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
