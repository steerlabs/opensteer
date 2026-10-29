import { requiredEnvironmentValue } from "@opensteer/shared/envParsing";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
/**
 * Assemble one complete, immutable Personal runtime release bundle for exactly
 * one operating system and architecture.
 *
 * `prepare-release-resources.ts` consumes the directory this script writes
 * through `OPENSTEER_PERSONAL_RUNTIME_SOURCE` and fails closed unless the
 * bundle is a self-contained tree with no symbolic links, one `release.json`
 * that declares every file with its SHA-256 digest and mode, and entrypoints
 * and harness executables that are real platform executables for the release
 * architecture.
 *
 * The bundle contains:
 *   - the reviewed PostgreSQL distribution (`postgres`, `initdb`, `pg_isready`,
 *     their shared libraries, and the `share` tree those binaries resolve
 *     relative to their own location);
 *   - one Node interpreter and fully bundled builds of the Host, Runner,
 *     Browser Harness, and messaging service, each fronted by a native launcher
 *     because Desktop starts entrypoints as plain executables with no
 *     arguments;
 *   - the Native filesystem helper;
 *   - every harness runtime the Runner executes, one per harness catalog entry
 *     (a single executable or a complete official runtime tree), named by the
 *     manifest's `harnesses` block, because the distribution that ships those
 *     bytes is what tells the Runner where they are.
 *
 * Release inputs are never downloaded here. Release CI supplies the reviewed
 * PostgreSQL and Node distributions, and the macOS/Windows release identity
 * signs every Mach-O artifact before its digest is pinned, because the manifest
 * digest is immutable once packaging starts.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  harnessCatalog,
  shipsHarnessRuntimeBytes,
  type HarnessRuntimeDescriptor,
  type ShippedHarnessCatalogEntry,
} from "@opensteer/core";
import { personalWebBuildId } from "@opensteer/protocol";
import { build } from "tsup";
import { writeWebDistributionManifest } from "../../../scripts/write-web-distribution-manifest.mjs";
import {
  PersonalRuntimeReleaseManifestSchema,
  readPersonalRuntimeRelease,
} from "../src/releases/personal-runtime-release.js";
import { personalRuntimeLayout } from "./personal-runtime-layout.js";
import { postgresReleaseVersion } from "./postgres-release-version.js";

const {
  signingKeychainArguments,
  readSigningMode,
  personalRuntimeSigningIdentity,
  personalRuntimeSigningOptions,
} = createRequire(import.meta.url)("./signing-input.cjs") as typeof import("./signing-input.cjs");

const { timePhase } = createRequire(import.meta.url)(
  "../../../scripts/release-phase-timing.cjs",
) as {
  timePhase: <T>(phase: string, work: () => Promise<T>) => Promise<T>;
};
type ArtifactMode = "code" | "data" | "executable";
type TargetOperatingSystem = "darwin" | "linux" | "win32";
type TargetArchitecture = "amd64" | "arm64";

interface StagedArtifact {
  readonly mode: ArtifactMode;
  readonly path: string;
}

const desktopDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(desktopDirectory, "../..");

const layout = personalRuntimeLayout;

const postgresEntrypoints = ["initdb", "pg_isready", "postgres"] as const;
const postgresRuntimeModules = ["dict_snowball", "plpgsql"] as const;

/**
 * Optional native accelerators that the reviewed runtime never ships. They stay
 * unresolved imports inside their own guarded lookups instead of pulling a
 * compiled addon into a signed release.
 */
const unbundledOptionalDependencies = ["bufferutil", "pg-native", "utf-8-validate"];

async function main(): Promise<void> {
  const releaseIdentity = process.env.OPENSTEER_SOURCE_REVISION
    ? (
        createRequire(import.meta.url)("../../../scripts/release-identity.cjs") as {
          requireCanonicalReleaseIdentity: (
            root: string,
            environment: NodeJS.ProcessEnv,
          ) => { sourceRevision: string; version: string };
        }
      ).requireCanonicalReleaseIdentity(repositoryRoot, process.env)
    : undefined;
  const targetOs = targetOperatingSystem();
  const targetArch = targetArchitecture();
  const output = path.resolve(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_PERSONAL_RUNTIME_OUTPUT",
      "OPENSTEER_PERSONAL_RUNTIME_OUTPUT is required to assemble a Personal runtime release.",
    ),
  );
  const postgresSource = path.resolve(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE",
      "OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE is required to assemble a Personal runtime release.",
    ),
  );
  const postgresVersion = await postgresReleaseVersion(
    postgresSource,
    targetOs,
    (executable, args, timeoutMs) => capture(executable, args, postgresSource, timeoutMs),
  );
  const interpreterSource = await resolveInterpreterSource(
    path.resolve(
      requiredEnvironmentValue(
        process.env,
        "OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE",
        "OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE is required to assemble a Personal runtime release.",
      ),
    ),
    targetOs,
  );
  const signingMode = targetOs === "darwin" ? readSigningMode() : undefined;
  const legacyIdentity = process.env.OPENSTEER_PERSONAL_RUNTIME_SIGNING_IDENTITY?.trim();
  const signingIdentity =
    signingMode?.mode === "signed" ? signingMode.signing.identity : legacyIdentity;
  if (legacyIdentity && legacyIdentity !== signingIdentity)
    throw Error("Personal runtime identity must match the signing input.");
  const executableSuffix = targetOs === "win32" ? ".exe" : "";
  const hostVersion = releaseIdentity?.version ?? (await workspaceVersion("apps/host"));
  const runnerVersion = releaseIdentity?.version ?? (await workspaceVersion("apps/runner"));
  const staging = `${output}.tmp-${process.pid}`;
  const webBuildDirectory = `${staging}.web-build`;
  await removeDirectory(staging);
  await removeDirectory(webBuildDirectory);
  try {
    const artifacts: StagedArtifact[] = [];
    await stageFile(
      path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
      path.join(staging, "THIRD_PARTY_NOTICES.md"),
    );
    artifacts.push({ mode: "data", path: "THIRD_PARTY_NOTICES.md" });

    artifacts.push(
      ...(await timedNodeService(
        staging,
        "browser-harness",
        path.join(repositoryRoot, "apps/runner/browser-harness/browser-harness.mjs"),
        {
          launcher: `${layout.browserHarnessLauncher}${executableSuffix}`,
          script: layout.browserHarnessScript,
        },
      )),
      ...(await timedNodeService(
        staging,
        "host",
        path.join(repositoryRoot, "apps/host/src/main.ts"),
        {
          launcher: `${layout.hostLauncher}${executableSuffix}`,
          script: layout.hostScript,
        },
      )),
      ...(await timedNodeService(
        staging,
        "runner",
        path.join(repositoryRoot, "apps/runner/src/main.ts"),
        { launcher: `${layout.runnerLauncher}${executableSuffix}`, script: layout.runnerScript },
      )),
      ...(await timedNodeService(
        staging,
        "channel-runtime",
        path.join(repositoryRoot, "apps/channel-runtime/src/main.ts"),
        {
          launcher: `${layout.channelRuntimeLauncher}${executableSuffix}`,
          script: layout.channelRuntimeScript,
        },
      )),
    );
    artifacts.push(...(await stageSharpRuntime(staging, targetOs, targetArch)));
    await timePhase("runtime.extension", () =>
      run(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["--filter", "@opensteer/browser-extension", "build"],
        repositoryRoot,
      ),
    );
    await timePhase("runtime.web", () =>
      run(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        [
          "--filter",
          "@opensteer/web",
          "exec",
          "vite",
          "build",
          "--outDir",
          webBuildDirectory,
          "--emptyOutDir",
        ],
        repositoryRoot,
      ),
    );
    if (!existsSync(path.join(webBuildDirectory, "browser-extension.zip"))) {
      throw new Error("Personal runtime Web distribution is missing the Chrome extension.");
    }
    const webArtifacts = await stageDataTree(webBuildDirectory, staging, layout.web);
    await writeWebDistributionManifest({
      buildId: personalWebBuildId,
      directory: path.join(staging, layout.web),
      hostVersion,
    });
    artifacts.push(...webArtifacts, { mode: "data", path: layout.webManifest });

    const interpreter = `${layout.interpreter}${executableSuffix}`;
    await stageFile(interpreterSource, path.join(staging, interpreter));
    artifacts.push({ mode: "executable", path: interpreter });

    // One staging pass per engine whose bytes this distribution ships: a file
    // runtime is one executable, a tree runtime is the whole directory its
    // executable resolves siblings in, and a script runtime is the Node
    // package tree the Runner's own interpreter runs. An `installed` engine
    // ships no bytes, so nothing here stages or names one.
    const stagedHarnesses: {
      readonly entry: ShippedHarnessCatalogEntry;
      readonly program: string;
    }[] = [];
    for (const entry of harnessCatalog) {
      if (!shipsHarnessRuntimeBytes(entry)) continue;
      if (entry.runtime.shape === "file") {
        if (entry.kind !== "opencode")
          throw new Error(`Personal runtime ${entry.kind} has no bundled file source.`);
        const program = `${entry.runtime.path}${executableSuffix}`;
        await stageFile(
          bundledHarnessExecutables[entry.kind](targetOs, targetArch),
          path.join(staging, program),
        );
        artifacts.push({ mode: "executable", path: program });
        stagedHarnesses.push({ entry, program });
        continue;
      }
      if (entry.kind !== "codex" && entry.kind !== "pi")
        throw new Error(`Personal runtime ${entry.kind} has no bundled tree source.`);
      // A script is named exactly as the catalog spells it: an interpreter is
      // given a path, not an executable the operating system suffixes.
      const program =
        entry.runtime.shape === "script"
          ? entry.runtime.path
          : `${entry.runtime.path}${executableSuffix}`;
      const runtime =
        entry.runtime.shape === "script"
          ? ({ entryScript: program, shape: "script" } as const)
          : ({ shape: "tree" } as const);
      for (const directory of bundledHarnessTrees[entry.kind](
        targetOs,
        targetArch,
        entry.runtime.treeRoot,
      )) {
        artifacts.push(
          ...(await stageRuntimeTree(
            directory.source,
            staging,
            directory.prefix,
            targetOs,
            runtime,
          )),
        );
      }
      stagedHarnesses.push({ entry, program });
    }

    const nativeFsHelper = `${layout.nativeFsHelper}${executableSuffix}`;
    await timePhase("runtime.native-fs", () =>
      buildGo({
        output: path.join(staging, nativeFsHelper),
        sourceDirectory: path.join(repositoryRoot, "apps/runner/native-fs-helper"),
        targetArch,
        targetOs,
      }),
    );
    artifacts.push({ mode: "executable", path: nativeFsHelper });

    // The computer-use helper is built here, beside the other native helper,
    // so one command produces both. It is not staged into this bundle: it is
    // an app of its own that LaunchServices starts, so it ships as a
    // top-level `extraResources` entry and `prepare-release-resources.ts`
    // pins it there.
    if (targetOs === "darwin")
      await timePhase("runtime.computer-use", () => buildComputerUseHelper(signingIdentity));

    artifacts.push(
      ...(await timePhase("runtime.postgres", () =>
        stagePostgres(postgresSource, staging, targetOs),
      )),
    );
    artifacts.push(
      ...(await stageDataTree(
        path.join(repositoryRoot, "apps/runner/agent-skills"),
        staging,
        layout.agentSkills,
      )),
    );

    if (targetOs === "darwin") {
      await assertNoExternalDarwinDependencies(staging, artifacts);
    }

    if (targetOs === "darwin") {
      await timePhase("runtime.sign", () =>
        signMachOArtifacts(staging, artifacts, personalRuntimeSigningIdentity()),
      );
    }

    for (const { entry, program } of stagedHarnesses) {
      const staged = path.join(staging, ...program.split("/"));
      // A script is run by the interpreter this same bundle ships, which is
      // exactly how the Runner will run it; anything else is a version read
      // from bytes the release does not contain.
      let version: string;
      if (entry.runtime.shape === "script") {
        version = await capture(
          path.join(staging, ...interpreter.split("/")),
          [staged, "--version"],
          repositoryRoot,
        );
      } else {
        await setFileMode(staged, 0o755);
        version = await capture(staged, ["--version"], repositoryRoot);
      }
      if (version !== entry.runtime.expectedVersion) {
        throw new Error(
          `Personal runtime ${entry.label} runtime has unexpected version ${version}.`,
        );
      }
    }

    const files = await Promise.all(
      [...artifacts]
        .sort((left, right) => (left.path < right.path ? -1 : 1))
        .map(async (artifact) => {
          const artifactPath = path.join(staging, ...artifact.path.split("/"));
          await setFileMode(artifactPath, artifact.mode === "executable" ? 0o555 : 0o444);
          return {
            mode: artifact.mode,
            path: artifact.path,
            sha256: createHash("sha256")
              .update(await readFile(artifactPath))
              .digest("hex"),
          };
        }),
    );

    await writeFile(
      path.join(staging, "release.json"),
      `${JSON.stringify({
        architecture: targetArch,
        assets: {
          agentSkills: layout.agentSkills,
          webDistribution: {
            directory: layout.web,
            hostVersion,
            manifest: layout.webManifest,
          },
        },
        entrypoints: {
          browserHarness: `${layout.browserHarnessLauncher}${executableSuffix}`,
          channelRuntime: `${layout.channelRuntimeLauncher}${executableSuffix}`,
          host: `${layout.hostLauncher}${executableSuffix}`,
          initdb: `${layout.postgres}/bin/initdb${executableSuffix}`,
          nativeFsHelper,
          node: interpreter,
          pgIsReady: `${layout.postgres}/bin/pg_isready${executableSuffix}`,
          postgres: `${layout.postgres}/bin/postgres${executableSuffix}`,
          runner: `${layout.runnerLauncher}${executableSuffix}`,
        },
        files,
        harnesses: Object.fromEntries(
          stagedHarnesses.map(({ entry, program }) => [entry.kind, program]),
        ),
        hostVersion,
        operatingSystem: targetOs,
        postgresMajor: Number(postgresVersion.split(".", 1)[0]),
        postgresVersion,
        runnerVersion,
        schemaVersion: 7,
      })}\n`,
      { encoding: "utf8", mode: 0o444 },
    );

    // Surface schema issues before the runtime reader wraps them for the UI.
    PersonalRuntimeReleaseManifestSchema.parse(
      JSON.parse(await readFile(path.join(staging, "release.json"), "utf8")),
    );

    // Fail here rather than during packaging: this is the exact verifier the
    // packaged Desktop runs against the bundle it starts.
    await timePhase("runtime.verify", () =>
      readPersonalRuntimeRelease(staging, {
        architecture: targetArch,
        operatingSystem: targetOs,
      }),
    );

    await removeDirectory(output);
    await rename(staging, output);
    if (releaseIdentity) {
      await replacePrivateFileAtomically(
        `${output}.provenance.json`,
        `${JSON.stringify({
          schemaVersion: 1,
          ...releaseIdentity,
          runnerSourceRevision:
            process.env.OPENSTEER_RUNNER_SOURCE_REVISION ?? releaseIdentity.sourceRevision,
          releaseManifestSha256: createHash("sha256")
            .update(await readFile(path.join(output, "release.json")))
            .digest("hex"),
        })}\n`,
      );
    }
    await removeDirectory(webBuildDirectory);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    await removeDirectory(staging).catch(() => undefined);
    await removeDirectory(webBuildDirectory).catch(() => undefined);
    throw error;
  }
}

export async function stageDataTree(
  source: string,
  staging: string,
  prefix: string,
): Promise<readonly StagedArtifact[]> {
  const artifacts: StagedArtifact[] = [];
  const walk = async (current: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Personal runtime data asset ${relative} must not be a symbolic link.`);
      }
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Personal runtime data asset ${relative} has an unsupported file type.`);
      }
      await stageFile(path.join(current, entry.name), path.join(staging, ...relative.split("/")));
      artifacts.push({ mode: "data", path: relative });
    }
  };
  await walk(source, prefix);
  return artifacts;
}

/**
 * Build one Node service into a single self-contained module plus its native
 * launcher. A Personal runtime release may not contain symbolic links and
 * declares every file it ships, so an installed `node_modules` tree is not a
 * releasable shape; the service is bundled instead.
 */
async function timedNodeService(...args: Parameters<typeof stageNodeService>) {
  return timePhase(`runtime.service.${args[1]}`, () => stageNodeService(...args));
}

export async function stageNodeService(
  staging: string,
  service: "browser-harness" | "channel-runtime" | "host" | "runner",
  entry: string,
  destination: { readonly launcher: string; readonly script: string },
): Promise<readonly StagedArtifact[]> {
  const scriptPath = path.join(staging, ...destination.script.split("/"));
  // Both resolve the native decoder staged beside them by `stageSharpRuntime`.
  const loadsSharp = service === "host" || service === "runner";
  await mkdir(path.dirname(scriptPath), { mode: 0o700, recursive: true });
  await timePhase(`runtime.bundle.${service}`, () =>
    build({
      banner: {
        js: "import{createRequire as __opensteerCreateRequire}from'node:module';const require=__opensteerCreateRequire(import.meta.url);",
      },
      bundle: true,
      clean: false,
      config: false,
      entry: { [service]: entry },
      external: [...unbundledOptionalDependencies, ...(loadsSharp ? ["sharp"] : [])],
      format: ["esm"],
      noExternal: [loadsSharp ? /^(?!sharp(?:$|\/)).*/u : /.*/u],
      outDir: path.dirname(scriptPath),
      outExtension: () => ({ js: ".mjs" }),
      platform: "node",
      silent: true,
      sourcemap: false,
      splitting: false,
      target: "node24",
      treeshake: false,
    }),
  );
  await rename(path.join(path.dirname(scriptPath), `${service}.mjs`), scriptPath);

  const launcherDirectory = path.dirname(path.join(staging, ...destination.launcher.split("/")));
  await timePhase(`runtime.launcher.${service}`, () =>
    buildGo({
      linkerFlags: [
        `-X main.interpreterRelativePath=${path.posix.relative(
          path.posix.dirname(destination.launcher),
          layout.interpreter,
        )}`,
        `-X main.scriptRelativePath=${path.posix.relative(
          path.posix.dirname(destination.launcher),
          destination.script,
        )}`,
      ],
      output: path.join(launcherDirectory, path.basename(destination.launcher)),
      sourceDirectory: path.join(desktopDirectory, "personal-runtime-launcher"),
      targetArch: targetArchitecture(),
      targetOs: targetOperatingSystem(),
    }),
  );

  return [
    { mode: "code", path: destination.script },
    { mode: "executable", path: destination.launcher },
  ];
}

/** Sharp's JS and native libraries sit beside host.mjs and runner.mjs so Node's
 * normal package resolver and the addon's own relative library paths see one
 * immutable tree. */
export async function stageSharpRuntime(
  staging: string,
  targetOs: TargetOperatingSystem,
  targetArch: TargetArchitecture,
): Promise<readonly StagedArtifact[]> {
  const hostRequire = createRequire(path.join(repositoryRoot, "apps/host/package.json"));
  const sharpEntry = hostRequire.resolve("sharp");
  const sharpDirectory = await installedPackageDirectory(sharpEntry, "sharp");
  const sharpRequire = createRequire(path.join(sharpDirectory, "package.json"));
  const architecture = targetArch === "amd64" ? "x64" : "arm64";
  let platformName: string = targetOs;
  if (targetOs === "linux") {
    const detectLibc = sharpRequire("detect-libc") as { readonly familySync: () => string | null };
    if (detectLibc.familySync() === "musl") platformName = "linuxmusl";
  }
  const platformPackage = `${platformName}-${architecture}`;
  const packages = [
    { name: "sharp", entry: sharpEntry },
    { name: "@img/colour", entry: sharpRequire.resolve("@img/colour") },
    { name: "detect-libc", entry: sharpRequire.resolve("detect-libc") },
    { name: "semver", entry: sharpRequire.resolve("semver") },
    {
      name: `@img/sharp-${platformPackage}`,
      entry: sharpRequire.resolve(`@img/sharp-${platformPackage}/sharp.node`),
    },
    ...(targetOs === "win32"
      ? []
      : [
          {
            name: `@img/sharp-libvips-${platformPackage}`,
            entry: sharpRequire.resolve(`@img/sharp-libvips-${platformPackage}/versions`),
          },
        ]),
  ];
  const artifacts: StagedArtifact[] = [];
  for (const item of packages) {
    const source = await installedPackageDirectory(item.entry, item.name);
    const prefix = `${personalRuntimeLayout.serviceModules}/${item.name}`;
    const staged = await stageRuntimeTree(source, staging, prefix, targetOs, { shape: "tree" });
    artifacts.push(
      ...staged.map((artifact) => ({
        ...artifact,
        mode: /\.(?:node|dll|dylib|so(?:\.[0-9.]+)?)$/u.test(artifact.path)
          ? ("code" as const)
          : artifact.mode,
      })),
    );
  }
  return artifacts;
}

async function installedPackageDirectory(entry: string, name: string): Promise<string> {
  let directory = path.dirname(realpathSync(entry));
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    const manifest = await readFile(manifestPath, "utf8").then(
      (content) => JSON.parse(content) as { name?: string },
      () => null,
    );
    if (manifest?.name === name) return directory;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`The ${name} package is missing from the release installation.`);
    directory = parent;
  }
}

/**
 * Every harness runtime is resolved from the Runner's own declared
 * dependencies, the same packages its bundled service resolves at run time when
 * no distribution names an executable. Resolving from the Desktop's tree would
 * let a different package version decide which bytes ship.
 *
 * `Record<HarnessKind, …>` is what makes a catalog engine whose bytes nothing
 * here knows how to find a compile error rather than a missing artifact.
 */
const runnerRequire = createRequire(path.join(repositoryRoot, "apps/runner/package.json"));

/** The catalog kinds whose runtime arrives in exactly one of the shapes. */
type HarnessKindWithShape<Shape extends HarnessRuntimeDescriptor["shape"]> = Extract<
  ShippedHarnessCatalogEntry,
  { readonly runtime: { readonly shape: Shape } }
>["kind"];

/** One directory of a staged runtime tree, and where in the bundle it goes. */
interface StagedRuntimeDirectory {
  /** Where it goes, relative to the root of the distribution. */
  readonly prefix: string;
  /** Where the bytes are, in the Runner's own installed dependencies. */
  readonly source: string;
}

const bundledHarnessExecutables: Record<
  HarnessKindWithShape<"file">,
  (targetOs: TargetOperatingSystem, targetArch: TargetArchitecture) => string
> = {
  opencode: bundledOpencodeExecutable,
};

const bundledHarnessTrees: Record<
  HarnessKindWithShape<"script" | "tree">,
  (
    targetOs: TargetOperatingSystem,
    targetArch: TargetArchitecture,
    treeRoot: string,
  ) => readonly StagedRuntimeDirectory[]
> = {
  codex: bundledCodexRuntime,
  pi: bundledPiRuntime,
};

/**
 * The target triples Codex's own `bin/codex.js` launcher uses to pick a vendor
 * directory. The bundle stages that directory whole, so the runtime finds
 * `codex-code-mode-host`, `rg` and its resources exactly where it looks.
 */
const codexVendorTriples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
} as const satisfies Record<string, string>;

function bundledCodexRuntime(
  targetOs: TargetOperatingSystem,
  targetArch: TargetArchitecture,
  treeRoot: string,
): readonly StagedRuntimeDirectory[] {
  const architecture = targetArch === "amd64" ? "x64" : "arm64";
  const triple = codexVendorTriples[`${targetOs}-${architecture}`];
  const codexRequire = createRequire(runnerRequire.resolve("@openai/codex/package.json"));
  const platformManifest = codexRequire.resolve(
    `@openai/codex-${targetOs}-${architecture}/package.json`,
  );
  return [
    { prefix: treeRoot, source: path.join(path.dirname(platformManifest), "vendor", triple) },
  ];
}

/**
 * OpenCode spells the operating system its own way in its platform package
 * names, and `win32` is not one of them. The `-baseline` variants are for x64
 * processors without AVX2 and the `-musl` ones for a musl Linux; a Personal
 * runtime targets neither, so the plain build is what ships.
 */
const opencodePlatforms = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
} as const satisfies Record<TargetOperatingSystem, string>;

/**
 * OpenCode is one self-contained Bun executable. `opencode-ai` itself only
 * carries a stub that its postinstall script hardlinks the platform package
 * over — and that script shells out to `npm install` when it cannot resolve
 * one, so it is never run here. The platform package is an optional
 * dependency pinned to the same version and is resolved directly, the way the
 * platform package is.
 */
function bundledOpencodeExecutable(
  targetOs: TargetOperatingSystem,
  targetArch: TargetArchitecture,
): string {
  const architecture = targetArch === "amd64" ? "x64" : "arm64";
  const opencodeRequire = createRequire(runnerRequire.resolve("opencode-ai/package.json"));
  const packageName = `opencode-${opencodePlatforms[targetOs]}-${architecture}`;
  return opencodeRequire.resolve(
    `${packageName}/bin/${targetOs === "win32" ? "opencode.exe" : "opencode"}`,
  );
}

/**
 * Pi is published as JavaScript, so its "runtime" is a Node package tree the
 * bundle's own interpreter runs.
 *
 * The Runner runs `dist/bundle/cli.js`, which inlines the engine but still
 * resolves two packages from a sibling `node_modules` at run time:
 * `@earendil-works/chord`, pi's own runtime, and `jiti`, which transpiles the
 * TypeScript extension the driver loads with `-e <file>.ts`. Measured against
 * 0.85.1 by staging exactly these three packages and running `--mode rpc`
 * with an extension that imports `typebox`; `typebox` resolves out of pi's
 * own bundle as a jiti virtual module, so it is not a package to stage.
 */
function bundledPiRuntime(
  _targetOs: TargetOperatingSystem,
  _targetArch: TargetArchitecture,
  treeRoot: string,
): readonly StagedRuntimeDirectory[] {
  const pi = nodePackageDirectory(
    path.join(repositoryRoot, "apps/runner"),
    "@earendil-works/pi-coding-agent",
  );
  return [
    { name: "@earendil-works/pi-coding-agent", source: pi },
    { name: "@earendil-works/chord", source: nodePackageDirectory(pi, "@earendil-works/chord") },
    { name: "jiti", source: nodePackageDirectory(pi, "jiti") },
  ].map(({ name, source }) => ({ prefix: `${treeRoot}/node_modules/${name}`, source }));
}

/**
 * Where an installed package lives, found the way Node's own resolver finds
 * it: the nearest `node_modules/<name>` with a manifest in it, walking up from
 * a starting directory. A package's `exports` map decides what may be
 * imported from it, not where it is, so resolving a subpath and climbing back
 * out would depend on what the package happens to publish.
 */
function nodePackageDirectory(from: string, name: string): string {
  let directory = path.resolve(from);
  for (;;) {
    const candidate = path.join(directory, "node_modules", ...name.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`The Runner does not install ${name}.`);
    directory = parent;
  }
}

/**
 * Stage a complete third-party runtime tree, preserving the relative paths its
 * own executables resolve against. Unlike {@link stageDataTree} the source's
 * execute bit decides the artifact mode, because a runtime ships programs it
 * spawns alongside the data files it reads.
 *
 * A `script` runtime is npm packages rather than a platform build. Exactly one
 * file in it is a program — the entry script the Runner names — and it is code
 * an interpreter reads, never an executable the release verifier would check
 * for this architecture's machine code; everything else is a module or a data
 * file the entry script reads. The package manager's own `node_modules` inside
 * such a package is not staged: every package the tree needs is staged beside
 * it, and what is left there are shims naming directories on the build machine.
 */
async function stageRuntimeTree(
  source: string,
  staging: string,
  prefix: string,
  targetOs: TargetOperatingSystem,
  runtime: { readonly shape: "tree" } | { readonly entryScript: string; readonly shape: "script" },
): Promise<readonly StagedArtifact[]> {
  const artifacts: StagedArtifact[] = [];
  const walk = async (current: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Personal runtime asset ${relative} must not be a symbolic link.`);
      }
      if (entry.isDirectory()) {
        if (runtime.shape === "script" && entry.name === "node_modules") continue;
        await walk(path.join(current, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Personal runtime asset ${relative} has an unsupported file type.`);
      }
      const sourcePath = path.join(current, entry.name);
      if (runtime.shape === "script") {
        await stageFile(sourcePath, path.join(staging, ...relative.split("/")));
        artifacts.push({
          mode: relative === runtime.entryScript ? "code" : "data",
          path: relative,
        });
        continue;
      }
      const executable =
        targetOs === "win32"
          ? entry.name.endsWith(".exe")
          : ((await lstat(sourcePath)).mode & 0o111) !== 0;
      await stageFile(sourcePath, path.join(staging, ...relative.split("/")));
      artifacts.push({ mode: executable ? "executable" : "data", path: relative });
    }
  };
  await walk(source, prefix);
  return artifacts;
}

/**
 * Copy exactly the PostgreSQL files the Personal Deployment starts and the
 * files those binaries resolve relative to their own location. Static archives,
 * development headers, documentation, and the client programs Desktop never
 * runs stay out of the signed release.
 */
async function stagePostgres(
  source: string,
  staging: string,
  targetOs: TargetOperatingSystem,
): Promise<readonly StagedArtifact[]> {
  const executableSuffix = targetOs === "win32" ? ".exe" : "";
  const artifacts: StagedArtifact[] = [];
  for (const entrypoint of postgresEntrypoints) {
    const relative = `${layout.postgres}/bin/${entrypoint}${executableSuffix}`;
    await stageFile(
      path.join(source, "bin", `${entrypoint}${executableSuffix}`),
      path.join(staging, ...relative.split("/")),
    );
    artifacts.push({ mode: "executable", path: relative });
  }

  const libraryExtension = targetOs === "darwin" ? ".dylib" : targetOs === "win32" ? ".dll" : ".so";
  for (const entry of await readdir(path.join(source, "lib"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(libraryExtension)) continue;
    const relative = `${layout.postgres}/lib/${entry.name}`;
    await stageFile(
      path.join(source, "lib", entry.name),
      path.join(staging, ...relative.split("/")),
    );
    artifacts.push({ mode: "code", path: relative });
  }

  if (targetOs !== "win32") {
    // The reviewed distribution keeps loadable modules either flat in lib/
    // (already staged by the shared-library loop above) or under
    // lib/postgresql/. Each required module must ship from wherever this
    // distribution actually puts it, preserving its relative location so the
    // binaries' own $libdir resolution keeps working in the bundle.
    for (const module of postgresRuntimeModules) {
      const moduleName = `${module}${libraryExtension}`;
      const nestedSource = path.join(source, "lib", "postgresql", moduleName);
      const nestedPresent = await lstat(nestedSource).then(
        (stats) => stats.isFile(),
        () => false,
      );
      if (nestedPresent) {
        const relative = `${layout.postgres}/lib/postgresql/${moduleName}`;
        await stageFile(nestedSource, path.join(staging, ...relative.split("/")));
        artifacts.push({ mode: "code", path: relative });
        continue;
      }
      if (!artifacts.some((artifact) => artifact.path === `${layout.postgres}/lib/${moduleName}`)) {
        throw new Error(
          `PostgreSQL runtime module ${moduleName} is missing from the reviewed distribution.`,
        );
      }
    }
  }

  const shareRoot = path.join(source, "share");
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (relative === `${layout.postgres}/share/doc`) continue;
        await walk(path.join(current, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      await stageFile(path.join(current, entry.name), path.join(staging, ...relative.split("/")));
      artifacts.push({ mode: "data", path: relative });
    }
  };
  await walk(shareRoot, `${layout.postgres}/share`);
  return artifacts;
}

/**
 * Sign every Mach-O artifact with the release identity and the hardened runtime
 * before its digest is pinned. Packaging copies these exact bytes into the app
 * and re-verifies both the digest and the signature after signing, so an
 * artifact that is signed later would invalidate its own manifest.
 */
async function signMachOArtifacts(
  staging: string,
  artifacts: readonly StagedArtifact[],
  identity: string,
): Promise<void> {
  const interpreterEntitlements = path.join(
    desktopDirectory,
    "build",
    "entitlements.mac.personal-interpreter.plist",
  );
  // The harness runtimes are programs the Runner spawns, signed with the same
  // hardened-runtime exceptions needed by their JITs; exceptions
  // apply per executable, and none of these needs more than JIT.
  const harnessEntitlements = path.join(
    desktopDirectory,
    "build",
    "entitlements.mac.inherit.plist",
  );
  const inheritsRunnerSandbox = (artifactPath: string): boolean =>
    harnessCatalog.some((entry) => {
      const { runtime } = entry;
      if (runtime.shape === "installed") return false;
      return runtime.shape === "file"
        ? artifactPath === runtime.path
        : artifactPath.startsWith(`${runtime.treeRoot}/`);
    });
  const signable = [...artifacts].sort(
    (left, right) => right.path.split("/").length - left.path.split("/").length,
  );
  for (const artifact of signable) {
    const artifactPath = path.join(staging, ...artifact.path.split("/"));
    if (!(await isMachO(artifactPath))) continue;
    await setFileMode(artifactPath, 0o755);
    await run(
      "/usr/bin/codesign",
      [
        "--force",
        ...signingKeychainArguments(),
        "--sign",
        identity,
        ...personalRuntimeSigningOptions(identity),
        ...(artifact.path === `${layout.interpreter}` ||
        artifact.path === `${layout.interpreter}.exe`
          ? ["--entitlements", interpreterEntitlements]
          : inheritsRunnerSandbox(artifact.path)
            ? ["--entitlements", harnessEntitlements]
            : []),
        artifactPath,
      ],
      repositoryRoot,
    );
  }
}

async function isMachO(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead < 4) return false;
    return [
      0xfe_ed_fa_ce, 0xfe_ed_fa_cf, 0xce_fa_ed_fe, 0xcf_fa_ed_fe, 0xca_fe_ba_be, 0xca_fe_ba_bf,
      0xbe_ba_fe_ca, 0xbf_ba_fe_ca,
    ].includes(header.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

async function assertNoExternalDarwinDependencies(
  staging: string,
  artifacts: readonly StagedArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    const artifactPath = path.join(staging, ...artifact.path.split("/"));
    if (!(await isMachO(artifactPath))) continue;
    const output = await capture("/usr/bin/otool", ["-L", artifactPath], repositoryRoot);
    const dependencies = output
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/u, 1)[0] ?? "")
      .filter(Boolean);
    for (const dependency of dependencies) {
      if (
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/") ||
        dependency.startsWith("@loader_path/") ||
        dependency.startsWith("@executable_path/") ||
        dependency.startsWith("@rpath/")
      ) {
        continue;
      }
      throw new Error(
        `Personal runtime artifact ${artifact.path} depends on external macOS library ${dependency}.`,
      );
    }
  }
}

async function stageFile(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Personal runtime input ${source} must be a real regular file.`);
  }
  await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
  await copyFile(source, destination);
  await setFileMode(destination, 0o644);
}

async function resolveInterpreterSource(
  source: string,
  targetOs: TargetOperatingSystem,
): Promise<string> {
  const metadata = await lstat(source);
  if (metadata.isDirectory()) {
    return targetOs === "win32" ? path.join(source, "node.exe") : path.join(source, "bin", "node");
  }
  return source;
}

async function workspaceVersion(relativeDirectory: string): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(repositoryRoot, relativeDirectory, "package.json"), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String((manifest as { version: unknown }).version)
      : "";
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`${relativeDirectory} does not declare a stable release version.`);
  }
  return version;
}

/**
 * Builds and signs `Opensteer Computer Use.app`.
 *
 * The Swift build script owns the bundle, its identifier and its signature —
 * including which designated requirement it compiles for the peer check — so
 * this only invokes it and passes the release identity along. A release build
 * refuses to continue without it; a developer build says what to run and goes
 * on, because a missing helper there means computer use is unavailable rather
 * than that the Personal runtime is broken.
 */
async function buildComputerUseHelper(signingIdentity: string | undefined): Promise<void> {
  const script = path.join(desktopDirectory, "scripts", "build-computer-use-helper.ts");
  if (!existsSync(script)) {
    if (process.env.OPENSTEER_DESKTOP_RELEASE === "1") {
      throw new Error(
        "scripts/build-computer-use-helper.ts is missing, so this release would ship no Computer use helper.",
      );
    }
    process.stderr.write(
      `${JSON.stringify({
        event: "personal-runtime.computer-use-helper.skipped",
        reason: "scripts/build-computer-use-helper.ts is not present in this checkout",
      })}\n`,
    );
    return;
  }
  const desktopRequire = createRequire(path.join(desktopDirectory, "package.json"));
  await run(
    process.execPath,
    [
      desktopRequire.resolve("tsx/cli"),
      script,
      ...(signingIdentity ? ["--sign", signingIdentity] : []),
    ],
    repositoryRoot,
  );
}

async function buildGo(options: {
  readonly linkerFlags?: readonly string[];
  readonly output: string;
  readonly sourceDirectory: string;
  readonly targetArch: TargetArchitecture;
  readonly targetOs: TargetOperatingSystem;
}): Promise<void> {
  await mkdir(path.dirname(options.output), { mode: 0o700, recursive: true });
  await run(
    "go",
    [
      "build",
      "-trimpath",
      `-ldflags=${[
        "-s",
        "-w",
        `-buildid=opensteer-native-fs-v1.6.0-${options.targetOs}-${options.targetArch}-production`,
        ...(options.targetOs === "darwin" ? ["-B", "gobuildid"] : []),
        ...(options.linkerFlags ?? []),
      ].join(" ")}`,
      "-o",
      options.output,
      ".",
    ],
    options.sourceDirectory,
    {
      CGO_ENABLED: "0",
      GOARCH: options.targetArch,
      GOOS: options.targetOs === "win32" ? "windows" : options.targetOs,
    },
  );
}

async function removeDirectory(directory: string): Promise<void> {
  // A finished bundle is read-only by design, so make it removable first.
  await run("/bin/chmod", ["-R", "u+w", directory], repositoryRoot, {}, "ignore").catch(
    () => undefined,
  );
  await rm(directory, { force: true, recursive: true });
}

function targetOperatingSystem(): TargetOperatingSystem {
  const value = process.env.OPENSTEER_DESKTOP_TARGET_OS ?? platform();
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  if (value === "windows") return "win32";
  throw new Error(`Unsupported Personal runtime operating system: ${value}`);
}

function targetArchitecture(): TargetArchitecture {
  const value = process.env.OPENSTEER_DESKTOP_TARGET_ARCH ?? arch();
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "amd64" || value === "x86_64") return "amd64";
  throw new Error(`Unsupported Personal runtime architecture: ${value}`);
}

async function run(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
  stdio: "ignore" | "inherit" = "inherit",
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: { ...process.env, ...environment },
      shell: false,
      stdio,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function capture(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(output.trim());
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
