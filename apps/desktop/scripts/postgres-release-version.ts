import path from "node:path";
import { z } from "zod";

const versionOutput = z
  .string()
  .trim()
  .regex(/^postgres \(PostgreSQL\) (?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/u);

export async function postgresReleaseVersion(
  source: string,
  targetOs: "darwin" | "linux" | "win32",
  capture: (executable: string, args: readonly string[], timeoutMs: number) => Promise<string>,
): Promise<string> {
  const executable = path.join(source, "bin", `postgres${targetOs === "win32" ? ".exe" : ""}`);
  let output: string;
  try {
    output = await capture(executable, ["--version"], 15_000);
  } catch (cause) {
    throw new Error(
      `Could not determine a stable PostgreSQL release version: ${executable} --version failed. Supply a runnable PostgreSQL distribution for the build host: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const result = versionOutput.safeParse(output);
  if (!result.success)
    throw new Error(
      `Could not determine a stable PostgreSQL release version from ${executable} --version: ${JSON.stringify(output)}. Expected postgres (PostgreSQL) MAJOR.MINOR[.PATCH].`,
    );
  const version = result.data.slice("postgres (PostgreSQL) ".length);
  return version.split(".").length === 2 ? `${version}.0` : version;
}
