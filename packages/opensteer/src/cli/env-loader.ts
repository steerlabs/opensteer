import { readFile } from "node:fs/promises";
import path from "node:path";

import { pathExists } from "../internal/filesystem.js";

const ENV_FILENAMES = [".env", ".env.local"] as const;

export async function loadCliEnvironment(cwd: string): Promise<void> {
  const protectedKeys = new Set(Object.keys(process.env));
  const directories = collectDirectories(cwd);

  for (const directory of directories) {
    for (const filename of ENV_FILENAMES) {
      const filePath = path.join(directory, filename);
      if (!(await pathExists(filePath))) {
        continue;
      }
      const parsed = parseEnvFile(await readFile(filePath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (protectedKeys.has(key)) {
          continue;
        }
        process.env[key] = value;
      }
    }
  }
}

function collectDirectories(cwd: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    directories.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    parsed[key] = parseEnvValue(rawValue);
  }

  return parsed;
}

function parseEnvValue(rawValue: string): string {
  if (
    rawValue.length >= 2 &&
    rawValue.startsWith('"') &&
    rawValue.endsWith('"')
  ) {
    return rawValue
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }

  if (
    rawValue.length >= 2 &&
    rawValue.startsWith("'") &&
    rawValue.endsWith("'")
  ) {
    return rawValue.slice(1, -1);
  }

  return rawValue.replace(/\s+#.*$/u, "").trimEnd();
}
