import { join } from "node:path";

/** Where `pnpm --filter @opensteer/desktop build:process-supervisor` writes this computer's supervisor. */
export function builtProcessSupervisor(
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const operatingSystem = { darwin: "darwin", linux: "linux", win32: "windows" }[
    platform as "darwin" | "linux" | "win32"
  ];
  const goArchitecture = { arm64: "arm64", x64: "amd64" }[architecture as "arm64" | "x64"];
  if (!operatingSystem || !goArchitecture)
    throw new Error(`The process supervisor does not support ${platform}-${architecture}`);
  return join(
    repositoryRoot,
    "apps",
    "desktop",
    "generated-native",
    `${operatingSystem}-${goArchitecture}`,
    `opensteer-process-supervisor${platform === "win32" ? ".exe" : ""}`,
  );
}
