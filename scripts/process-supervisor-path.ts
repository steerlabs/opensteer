import { statSync } from "node:fs";
import { join } from "node:path";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";

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

/** Points a source entrypoint's engine launches at the built supervisor, or says how to build it. */
export function provideBuiltProcessSupervisor(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): string {
  const supervisor =
    environment[processSupervisorExecutableVariable]?.trim() ||
    builtProcessSupervisor(repositoryRoot);
  if (!statSync(supervisor, { throwIfNoEntry: false })?.isFile())
    throw new Error(
      `${supervisor} is missing; build it with: pnpm --filter @opensteer/desktop build:process-supervisor`,
    );
  environment[processSupervisorExecutableVariable] = supervisor;
  return supervisor;
}
