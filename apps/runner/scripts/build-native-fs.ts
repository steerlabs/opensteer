import { spawn } from "node:child_process";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const helperDirectory = path.join(runnerDirectory, "native-fs-helper");
const testBuild = process.argv.slice(2).includes("--test");
const targetOperatingSystem = process.env.GOOS?.trim() || platform();
const outputName = `opensteer-native-fs${testBuild ? "-test" : ""}${
  targetOperatingSystem === "win32" || targetOperatingSystem === "windows" ? ".exe" : ""
}`;
const targetArchitecture = (process.env.GOARCH?.trim() || arch()).replace("x64", "amd64");
// Go's internal linker writes a Mach-O UUID only when asked with `-B gobuildid`.
// A stable, per-target Go build ID makes that UUID deterministic without
// reusing one across architectures or test builds.
const deterministicBuildId = `opensteer-native-fs-v1.6.0-${targetOperatingSystem}-${targetArchitecture}-${
  testBuild ? "test" : "production"
}`;
const linkerFlags = [
  `-buildid=${deterministicBuildId}`,
  ...(targetOperatingSystem === "darwin" ? ["-B gobuildid"] : []),
  ...(testBuild ? ["-X main.allowNonMountRootsForTests=true"] : []),
].join(" ");

await new Promise<void>((resolve, reject) => {
  const child = spawn(
    "go",
    ["build", "-trimpath", `-ldflags=${linkerFlags}`, "-o", outputName, "."],
    {
      cwd: helperDirectory,
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Go native filesystem build failed (${signal ?? `exit ${code}`}).`));
  });
});
