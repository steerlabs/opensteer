import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertRegularFile } from "@opensteer/shared/privateFiles";
import { spawn } from "node:child_process";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { mkdir } from "node:fs/promises";
import { arch as hostArchitecture, platform as hostPlatform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDirectory = path.join(desktopDirectory, "process-supervisor");
const operatingSystem = normalizedOperatingSystem(
  process.env.OPENSTEER_DESKTOP_TARGET_OS ?? process.env.GOOS ?? hostPlatform(),
);
const architecture = normalizedArchitecture(
  process.env.OPENSTEER_DESKTOP_TARGET_ARCH ?? process.env.GOARCH ?? hostArchitecture(),
);
const outputDirectory = path.join(
  desktopDirectory,
  "generated-native",
  `${operatingSystem}-${architecture}`,
);
const output = path.join(
  outputDirectory,
  operatingSystem === "windows"
    ? "opensteer-process-supervisor.exe"
    : "opensteer-process-supervisor",
);

const reviewedSource = process.env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE;
// Explicit reviewed inputs are immutable in contributor builds too; lifecycle
// hooks must not rebuild the producer’s bytes after their digest was pinned.
if (process.env.OPENSTEER_DESKTOP_RELEASE === "1" || reviewedSource !== undefined) {
  if (!reviewedSource || !process.env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256)
    throw new Error("Release requires a reviewed supervisor input");
  await assertRegularFile(reviewedSource, "Reviewed supervisor input");
  if (
    createHash("sha256")
      .update(await readFile(reviewedSource))
      .digest("hex") !== process.env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256
  )
    throw new Error("Reviewed supervisor input digest differs");
  process.stdout.write(`${reviewedSource} (reviewed release input)\n`);
} else {
  await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  await runGo(["build", "-trimpath", "-ldflags=-buildid=", "-o", output, "."]);
  if (operatingSystem !== "windows") await setFileMode(output, 0o555);
  process.stdout.write(`${output}\n`);
}

function normalizedOperatingSystem(value: string): "darwin" | "linux" | "windows" {
  switch (value.trim().toLowerCase()) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
    case "windows":
      return "windows";
    default:
      throw new Error(`Unsupported process-supervisor operating system: ${value}`);
  }
}

function normalizedArchitecture(value: string): "amd64" | "arm64" {
  switch (value.trim().toLowerCase()) {
    case "amd64":
    case "x64":
    case "x86_64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported process-supervisor architecture: ${value}`);
  }
}

async function runGo(arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("go", [...arguments_], {
      cwd: sourceDirectory,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOARCH: architecture,
        GOOS: operatingSystem,
      },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `Go process-supervisor build failed (${signal ?? `exit ${code ?? "unknown"}`}).`,
          ),
        );
      }
    });
  });
}
