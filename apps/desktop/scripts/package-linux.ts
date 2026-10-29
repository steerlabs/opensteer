import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { arch as hostArchitecture } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { desktopReleaseMetadata } = require("./desktop-release-metadata.cjs") as {
  readonly desktopReleaseMetadata: (
    repositoryRoot: string,
    environment?: NodeJS.ProcessEnv,
  ) => { readonly builderArguments: readonly string[] };
};

const packageManager = process.env.npm_execpath;
if (!packageManager) {
  throw new Error("pnpm did not provide npm_execpath to the Desktop release script.");
}

const targetArchitecture = linuxArchitecture(
  process.env.OPENSTEER_DESKTOP_TARGET_ARCH ?? hostArchitecture(),
);
const desktopDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseMetadata = desktopReleaseMetadata(
  path.resolve(desktopDirectory, "../.."),
  process.env,
);
const builderConfig = desktopBuilderConfig(process.env.OPENSTEER_DESKTOP_RELEASE_CHANNEL);
const releaseEnvironment = {
  ...process.env,
  OPENSTEER_DESKTOP_RELEASE: "1",
  OPENSTEER_DESKTOP_TARGET_ARCH: targetArchitecture.manifest,
  OPENSTEER_DESKTOP_TARGET_OS: "linux",
};

await run(["prepare:release-resources"], releaseEnvironment);
await run(["build"], releaseEnvironment);
await run(
  [
    "exec",
    "electron-builder",
    "--linux",
    "--config",
    builderConfig,
    ...releaseMetadata.builderArguments,
    targetArchitecture.builderFlag,
  ],
  releaseEnvironment,
);

function desktopBuilderConfig(channel: string | undefined): string {
  if (channel === "beta") return "electron-builder.beta.yml";
  if (channel === "stable") return "electron-builder.yml";
  throw new Error("OPENSTEER_DESKTOP_RELEASE_CHANNEL must be beta or stable.");
}

function linuxArchitecture(value: string): {
  readonly builderFlag: "--arm64" | "--x64";
  readonly manifest: "amd64" | "arm64";
} {
  switch (value.trim().toLowerCase()) {
    case "amd64":
    case "x64":
    case "x86_64":
      return { builderFlag: "--x64", manifest: "amd64" };
    case "aarch64":
    case "arm64":
      return { builderFlag: "--arm64", manifest: "arm64" };
    default:
      throw new Error(`Unsupported Linux Desktop release architecture: ${value}`);
  }
}

async function run(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [packageManager, ...arguments_], {
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`pnpm failed (${signal ?? `exit ${code ?? "unknown"}`}).`));
    });
  });
}
