/** Cache compiler products only; every caller still packages and signs a new bundle. */
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { sha256File } from "@opensteer/shared/fileDigest";
import { acquireReleaseLock, runBounded } from "../../../scripts/command-runner.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const productName = z.string().regex(/^[A-Za-z][A-Za-z0-9]+$/u);
const productsSchema = z.record(
  productName,
  z.strictObject({ sha256: digest, bytes: z.number().int().nonnegative() }),
);
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputDigest: digest,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  products: productsSchema,
});
export interface NativeInputProof {
  readonly digest: string;
  readonly roots: readonly { readonly name: string; readonly sha256: string }[];
  readonly settings: Readonly<Record<string, string>>;
}
interface Root {
  readonly name: string;
  readonly path: string;
}

/** Hash actual bytes, modes and link targets; absolute checkout names and mtimes
 * are not compilation inputs. Generated Swift/plist inputs must already exist. */
export async function hashNativeInputs(
  roots: readonly Root[],
  settings: Readonly<Record<string, string>>,
): Promise<NativeInputProof> {
  const allowed = await Promise.all(roots.map(async (root) => realpath(root.path)));
  const deadline = Date.now() + 15_000;
  const signal = AbortSignal.timeout(15_000);
  const proof: { name: string; sha256: string }[] = [];
  for (const root of roots) {
    const hash = createHash("sha256");
    const walk = async (
      filename: string,
      label: string,
      ancestry: ReadonlySet<string>,
    ): Promise<void> => {
      if (Date.now() >= deadline) throw Error(`Native cache input budget exceeded: ${root.name}`);
      const before = await lstat(filename);
      hash.update(canonicalJson({ path: label, mode: before.mode & 0o7777 }));
      if (before.isSymbolicLink()) {
        const target = await realpath(filename);
        if (!allowed.some((base) => target === base || target.startsWith(base + path.sep)))
          throw Error(`Undeclared native input link: ${root.name}:${label}`);
        hash.update(await readlink(filename));
        await walk(target, label + "/@resolved", ancestry);
      } else if (before.isDirectory()) {
        const key = `${before.dev}:${before.ino}`;
        if (ancestry.has(key)) {
          // The link text is already bound; this ancestor's full inventory is
          // being hashed by the enclosing traversal. Xcode SDKs contain these.
          hash.update("ancestor-directory-reference");
        } else {
          const children = (await readdir(filename)).sort();
          for (const child of children)
            await walk(
              path.join(filename, child),
              label + "/" + child,
              new Set([...ancestry, key]),
            );
          if (canonicalJson((await readdir(filename)).sort()) !== canonicalJson(children))
            throw Error("Native inputs changed");
        }
      } else if (before.isFile()) hash.update(await sha256File(filename, signal));
      else throw Error("Unsupported native input");
      const after = await lstat(filename);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.mode !== after.mode ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw Error("Native input changed while hashing");
    };
    await walk(root.path, ".", new Set());
    proof.push({ name: root.name, sha256: hash.digest("hex") });
  }
  proof.sort((a, b) => a.name.localeCompare(b.name));
  return {
    digest: createHash("sha256")
      .update(canonicalJson({ roots: proof, settings }))
      .digest("hex"),
    roots: proof,
    settings: { ...settings },
  };
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  )
    throw Error("Unsafe native cache directory");
}
async function regular(filename: string) {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.()
  )
    throw Error("Unsafe native cache file");
  return metadata;
}
function record(
  kind: string,
  cache: "hit" | "miss",
  started: number,
  proof?: NativeInputProof,
  origin?: string,
) {
  try {
    const filename = process.env.OPENSTEER_RELEASE_TIMING_FILE;
    if (filename)
      void appendFile(
        filename,
        JSON.stringify({
          id: randomUUID(),
          parentId: process.env.OPENSTEER_RELEASE_COMMAND_ID,
          phase: `runtime.native-cache.${kind}`,
          event: "complete",
          cache,
          elapsedMs: performance.now() - started,
          at: new Date().toISOString(),
          inputDigest: proof?.digest,
          compiledSourceRevision: origin,
        }) + "\n",
        { mode: 0o600 },
      ).catch(() => undefined);
    process.stdout.write(`Native compiler products (${kind}): ${cache}\n`);
  } catch {
    /* Cache diagnostics cannot stop a build. */
  }
}

export async function nativeBuildProducts(options: {
  kind: "computer-use" | "passwords";
  sourceRevision: string;
  cacheDirectory?: string | undefined;
  names: readonly string[];
  inputs: () => Promise<NativeInputProof | undefined>;
  build: () => Promise<Readonly<Record<string, string>>>;
  verify: (products: Readonly<Record<string, string>>) => Promise<void>;
  packageAndVerify: (products: Readonly<Record<string, string>>) => Promise<void>;
}): Promise<{ hit: boolean }> {
  const started = performance.now();
  let proof: NativeInputProof | undefined;
  let release: (() => Promise<void>) | undefined;
  let entry: string | undefined;
  let selectedDirectory: string | undefined;
  try {
    if (!/^[a-f0-9]{40}$/u.test(options.sourceRevision))
      throw Error("Native source identity unavailable");
    proof = await options.inputs();
    if (!proof) throw Error("Native cache disabled or input identity unavailable");
    digest.parse(proof.digest);
    const root = options.cacheDirectory ?? path.join(homedir(), ".cache/opensteer/native-products");
    await privateDirectory(root);
    const directory = path.join(root, options.kind);
    await privateDirectory(directory);
    release = await acquireReleaseLock(path.join(directory, proof.digest + ".lock"));
    entry = path.join(directory, proof.digest);
    await privateDirectory(entry);
    if ((await regular(path.join(entry, "record.json"))).size > 1_048_576)
      throw Error("Oversized native cache record");
    if (
      (await regular(path.join(entry, "inputs.json"))).size > 1_048_576 ||
      (await readFile(path.join(entry, "inputs.json"), "utf8")) !== canonicalJson(proof)
    )
      throw Error("Native cache input proof differs");
    const metadata = recordSchema.parse(
      JSON.parse(await readFile(path.join(entry, "record.json"), "utf8")),
    );
    if (
      canonicalJson(Object.keys(metadata.products).sort()) !==
      canonicalJson([...options.names].sort())
    )
      throw Error("Native cache product set differs");
    if (metadata.inputDigest !== proof.digest) throw Error("Native cache key differs");
    if (
      canonicalJson((await readdir(entry)).sort()) !==
      canonicalJson(["inputs.json", "record.json", ...Object.keys(metadata.products)].sort())
    )
      throw Error("Native cache entry set differs");
    const products: Record<string, string> = {};
    selectedDirectory = await mkdtemp(path.join(directory, ".selected-"));
    for (const [name, expected] of Object.entries(metadata.products)) {
      const filename = path.join(entry, name);
      const stat = await regular(filename);
      if (stat.size !== expected.bytes) throw Error("Native cache product changed");
      const selected = path.join(selectedDirectory, name);
      await copyFile(filename, selected);
      if (
        (await regular(selected)).size !== expected.bytes ||
        (await sha256File(selected)) !== expected.sha256
      )
        throw Error("Native cache product changed");
      products[name] = selected;
    }
    await options.verify(products);
    await options.packageAndVerify(products);
    record(options.kind, "hit", started, proof, metadata.sourceRevision);
    await release();
    release = undefined;
    await rm(selectedDirectory, { recursive: true, force: true }).catch(() => undefined);
    return { hit: true };
  } catch {
    // Missing, ambiguous, poisoned, busy or inaccessible cache => original build.
    if (selectedDirectory)
      await rm(selectedDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  const products = await options
    .build()
    .then(async (built) => {
      await options.packageAndVerify(built);
      return built;
    })
    .catch(async (error: unknown) => {
      await release?.();
      release = undefined;
      throw error;
    });
  try {
    if (proof && entry && release) {
      await options.verify(products);
      const after = await options.inputs();
      if (!after || after.digest !== proof.digest)
        throw Error("Native inputs changed during compilation");
      const temporary = `${entry}.tmp-${randomUUID()}`;
      try {
        await mkdir(temporary, { mode: 0o700 });
        const payload: z.infer<typeof productsSchema> = {};
        for (const [name, filename] of Object.entries(products)) {
          productName.parse(name);
          const target = path.join(temporary, name);
          await copyFile(filename, target);
          payload[name] = { sha256: await sha256File(target), bytes: (await regular(target)).size };
        }
        await writeFile(path.join(temporary, "inputs.json"), canonicalJson(proof), { mode: 0o600 });
        await writeFile(
          path.join(temporary, "record.json"),
          JSON.stringify(
            recordSchema.parse({
              schemaVersion: 1,
              inputDigest: proof.digest,
              sourceRevision: options.sourceRevision,
              products: payload,
            }),
          ),
          { mode: 0o600 },
        );
        // A miss created an empty entry at most. Never overwrite a poisoned one.
        await rmdir(entry); // succeeds only for an empty directory
        await rename(temporary, entry);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  } catch {
    /* Publication is opportunistic; normal fresh products remain valid. */
  } finally {
    await release?.().catch(() => undefined);
  }
  record(options.kind, "miss", started, proof);
  return { hit: false };
}

/** Apple-signed Xcode installs are immutable per build. Capture the identities
 * actually selected by the same launcher environment that performs the build. */
export async function nativeToolchainIdentity(
  run: (executable: string, args: readonly string[]) => Promise<string> = (executable, args) =>
    runBounded(executable, args, { timeoutMs: 10_000 }),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<Record<string, string>>> {
  const results = await Promise.allSettled([
    run("/usr/bin/xcodebuild", ["-version"]),
    run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
    run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]),
    run("/usr/bin/swift", ["--version"]),
    environment.DEVELOPER_DIR
      ? Promise.resolve(environment.DEVELOPER_DIR)
      : run("/usr/bin/xcode-select", ["-p"]),
  ]);
  const values = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    const value = result.value.trim();
    if (!value) throw Error("Missing native toolchain identity");
    return value;
  });
  const [xcode, sdkVersion, sdkBuild, swift, developer] = values as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!path.isAbsolute(developer)) throw Error("DEVELOPER_DIR must resolve from an absolute path");
  const developerDirectory = await realpath(
    developer.endsWith(".app") ? path.join(developer, "Contents/Developer") : developer,
  );
  return { xcode, sdkVersion, sdkBuild, swift, developerDirectory };
}

/** Changes to compilation recipes must invalidate cached executable products. */
export function nativeBuildRecipeInputs(root: string, kind: "computer-use" | "passwords"): Root[] {
  return [
    {
      name: "builder",
      path: path.join(
        root,
        `apps/desktop/scripts/build-${kind === "computer-use" ? "computer-use-helper" : "passwords-broker"}.ts`,
      ),
    },
    {
      name: "swift-builder",
      path: path.join(root, "apps/desktop/scripts/build-swift-products.ts"),
    },
    { name: "cache-recipe", path: path.join(root, "apps/desktop/scripts/native-build-cache.ts") },
  ];
}

/** Cache errors/unknown overrides are misses. Sources and declared non-SDK
 * include roots still bind actual bytes, not declared versions or mtimes. */
export async function nativeReleaseInputs(
  root: string,
  kind: "computer-use" | "passwords",
  identity: string,
  architectures: readonly string[],
): Promise<NativeInputProof | undefined> {
  if (process.env.OPENSTEER_NATIVE_BUILD_CACHE === "off") return undefined;
  if (
    Object.keys(process.env).some((key) =>
      /^(?:SWIFT|CLANG|CC$|CXX|CFLAGS|LDFLAGS|LD$|AR$|SDKROOT|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|LIBRARY_PATH|DYLD_|LD_LIBRARY_PATH|MACOSX_DEPLOYMENT_TARGET|ARCHS$)/u.test(
        key,
      ),
    )
  )
    return undefined;
  // The shared Mac exports a JDK include flag. Declare and hash the headers
  // rather than silently ignoring ambient flags or changing build semantics.
  const includeFlags = process.env.CPPFLAGS?.trim().split(/\s+/u).filter(Boolean) ?? [];
  if (includeFlags.some((flag) => !/^-I\/[A-Za-z0-9_@./+-]+$/u.test(flag))) return undefined;
  const run = (executable: string, args: readonly string[]) =>
    runBounded(executable, args, { cwd: root, timeoutMs: 10_000 });
  const toolchain = await nativeToolchainIdentity(run);
  const { readSigningMode } = createRequire(import.meta.url)(
    "./signing-input.cjs",
  ) as typeof import("./signing-input.cjs");
  const signingMode = readSigningMode();
  const keychain = signingMode.mode === "signed" ? signingMode.signing.keychain : undefined;
  const identities = (
    await run("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      ...(keychain ? [keychain] : []),
    ])
  )
    .split("\n")
    .filter((line) => line.includes(identity));
  if (identities.length !== 1) return undefined;
  const native = path.join(
    root,
    "apps/desktop/native",
    kind === "computer-use" ? "computer-use" : "passwords",
  );
  const roots: Root[] = [
    { name: "self-signing-sources", path: path.join(root, "packages/macos-signing/Sources") },
    { name: "self-signing-package", path: path.join(root, "packages/macos-signing/Package.swift") },
    { name: "sources", path: path.join(native, "Sources") },
    { name: "package", path: path.join(native, "Package.swift") },
    ...nativeBuildRecipeInputs(root, kind),
    { name: "host-os", path: "/System/Library/CoreServices/SystemVersion.plist" },
    ...includeFlags.map((flag, index) => ({ name: `include-${index}`, path: flag.slice(2) })),
  ];
  // Homebrew's JDK include directory is a facade of links into its sibling
  // libexec tree. Declare that bounded header root, never arbitrary referents.
  for (const [index, flag] of includeFlags.entries()) {
    const include = flag.slice(2);
    if (/^\/opt\/homebrew\/opt\/openjdk(?:@\d+)?\/include\/?$/u.test(include))
      roots.push({
        name: `include-${index}-jdk-headers`,
        path: path.join(include, "../libexec/openjdk.jdk/Contents/Home/include"),
      });
  }
  if (kind === "computer-use") {
    roots.push(
      { name: "apple-sources", path: path.join(root, "packages/apple-data/Sources") },
      { name: "apple-package", path: path.join(root, "packages/apple-data/Package.swift") },
    );
  }
  for (const name of ["Package.resolved", ".swiftpm"]) {
    const filename = path.join(native, name);
    try {
      await lstat(filename);
      roots.push({ name, path: filename });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const profile = process.env.OPENSTEER_PASSWORDS_PROVISIONING_PROFILE;
  if (kind === "passwords" && profile) roots.push({ name: "profile", path: profile });
  return hashNativeInputs(roots, {
    ...toolchain,
    buildMode: "release",
    signingForm: "certificate",
    identity: identities[0]!.trim(),
    architectures: architectures.join(","),
    flags: "-c release",
    platform: "macos14",
    host: process.arch,
    cppFlags: process.env.CPPFLAGS ?? "",
  });
}

export async function verifyNativeProducts(
  products: Readonly<Record<string, string>>,
  architectures: readonly string[],
  run: typeof runBounded = runBounded,
) {
  for (const filename of Object.values(products)) {
    const actual = await run("/usr/bin/lipo", ["-archs", filename], {
      timeoutMs: 10_000,
    });
    if (
      canonicalJson(actual.trim().split(/\s+/u).sort()) !== canonicalJson([...architectures].sort())
    )
      throw Error("Native product architectures differ");
  }
}
