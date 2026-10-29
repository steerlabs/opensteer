import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { z } from "zod";

const EnginePackageSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

/** Read the owning package of the actual artifact, never a separately resolved dependency. */
export async function engineArtifactPackageVersion(
  executable: string,
  packageName: RegExp,
): Promise<string> {
  const artifact = await realpath(executable);
  if (!(await stat(artifact)).isFile()) throw new Error(`${artifact} is not a regular file`);
  let directory = dirname(artifact);
  for (;;) {
    const manifest = join(directory, "package.json");
    let source: string;
    try {
      source = await readFile(manifest, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`No package manifest above ${artifact}`);
      directory = parent;
      continue;
    }
    try {
      const parsed = EnginePackageSchema.parse(JSON.parse(source));
      if (!packageName.test(parsed.name)) throw new Error(`Unexpected package ${parsed.name}`);
      return parsed.version;
    } catch (cause) {
      throw new Error(
        `Invalid engine package manifest ${manifest}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
}
