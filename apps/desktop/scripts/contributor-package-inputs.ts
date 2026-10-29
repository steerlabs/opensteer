import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { supportsCloudflaredTokenFile } = require("./after-sign.cjs") as {
  supportsCloudflaredTokenFile: (version: string) => boolean;
};

const inputs = z.object({
  OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: z.string().trim().min(1),
  OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: z.string().trim().min(1),
  OPENSTEER_CLOUDFLARED_BINARY_SOURCE: z.string().trim().min(1),
  OPENSTEER_CLOUDFLARED_RELEASE_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/u),
  OPENSTEER_CLOUDFLARED_BINARY_SHA256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const layout =
  "Required layout: relocatable PostgreSQL 17 with bin/postgres, bin/initdb, bin/pg_isready, lib/ (including dict_snowball and plpgsql modules) and share/; Node distribution with bin/node; cloudflared executable with its stable version (2025.4.0 or newer) and lowercase SHA-256 digest. macOS libraries must resolve through @loader_path or other relative paths, with no external libraries.";

export function contributorPackageInputs(environment: NodeJS.ProcessEnv): z.infer<typeof inputs> {
  const parsed = inputs.safeParse(environment);
  if (!parsed.success) {
    throw Error(
      `Missing or invalid contributor inputs: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}.\n${layout}`,
    );
  }
  const result = parsed.data;
  const files = [
    ...["postgres", "initdb", "pg_isready"].map((name) =>
      path.join(result.OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE, "bin", name),
    ),
    path.join(result.OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE, "bin/node"),
    result.OPENSTEER_CLOUDFLARED_BINARY_SOURCE,
  ];
  const directories = ["lib", "share"].map((name) =>
    path.join(result.OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE, name),
  );
  const invalid = [
    ...files.filter((file) => !hasType(file, "file")),
    ...directories.filter((directory) => !hasType(directory, "directory")),
  ];
  const problems = invalid.length ? [`Invalid input layout: ${invalid.join(", ")}.`] : [];
  // Packaging builds the whole runtime before staging rejects cloudflared, so check it here.
  if (!supportsCloudflaredTokenFile(result.OPENSTEER_CLOUDFLARED_RELEASE_VERSION)) {
    problems.push("OPENSTEER_CLOUDFLARED_RELEASE_VERSION must be 2025.4.0 or newer.");
  }
  if (!invalid.includes(result.OPENSTEER_CLOUDFLARED_BINARY_SOURCE)) {
    const actual = createHash("sha256")
      .update(readFileSync(result.OPENSTEER_CLOUDFLARED_BINARY_SOURCE))
      .digest("hex");
    if (actual !== result.OPENSTEER_CLOUDFLARED_BINARY_SHA256) {
      problems.push(
        `cloudflared binary digest mismatch: expected ${result.OPENSTEER_CLOUDFLARED_BINARY_SHA256}, got ${actual}.`,
      );
    }
  }
  if (problems.length) throw Error(`${problems.join("\n")}\n${layout}`);
  return result;
}

function hasType(candidate: string, type: "file" | "directory"): boolean {
  try {
    const metadata = statSync(candidate);
    return type === "file" ? metadata.isFile() : metadata.isDirectory();
  } catch {
    return false;
  }
}
