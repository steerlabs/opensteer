import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contributorPackageInputs } from "./contributor-package-inputs.js";

const require = createRequire(import.meta.url);
const { readSigningMode } = require("./signing-input.cjs") as typeof import("./signing-input.cjs");
if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) {
  throw Error("Contributor macOS packaging requires an arm64 or x64 Mac.");
}
if (process.env.OPENSTEER_DESKTOP_RELEASE === "1" || readSigningMode().mode !== "development") {
  throw Error(
    "Contributor packaging requires development mode without a signing input. Use package:mac for releases.",
  );
}
const inputs = contributorPackageInputs(process.env);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), "opensteer-contributor-package-"));
const environment = {
  ...process.env,
  ...inputs,
  OPENSTEER_DESKTOP_RELEASE: "0",
  OPENSTEER_DESKTOP_TARGET_OS: "darwin",
  OPENSTEER_DESKTOP_TARGET_ARCH: process.arch === "x64" ? "amd64" : "arm64",
  // Resource staging selects the source policy internally; contributors supply
  // runtime inputs, not a distribution channel or release identity.
  OPENSTEER_DESKTOP_RELEASE_CHANNEL: "stable",
  OPENSTEER_PERSONAL_RUNTIME_OUTPUT: path.join(scratch, "runtime"),
  OPENSTEER_PERSONAL_RUNTIME_SOURCE: path.join(scratch, "runtime"),
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
};
async function pnpm(...args: string[]): Promise<void> {
  const executable = process.env.npm_execpath;
  if (!executable) throw Error("Run this command through pnpm.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: desktop,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(Error(`pnpm ${args.join(" ")}: ${signal ?? code}`)),
    );
  });
}
try {
  await pnpm("exec", "tsx", "scripts/build-personal-runtime.ts");
  await pnpm("build:passwords-broker");
  await pnpm("prepare:release-resources");
  await pnpm("build");
  // One literal argv, so the signing-invocation guard sees the ad-hoc identity it exempts.
  const electronBuilder = [
    "exec",
    "electron-builder",
    "--mac",
    "--dir",
    process.arch === "arm64" ? "--arm64" : "--x64",
    "--config",
    "electron-builder.yml",
    "-c.mac.identity=-",
    "-c.mac.notarize=false",
    "-c.mac.hardenedRuntime=false",
  ];
  await pnpm(...electronBuilder);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
