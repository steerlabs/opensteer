import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILENAMES = [".env", ".env.local"] as const;
const OPENSTEER_ENV_PREFIX = "OPENSTEER_";

export type OpensteerEnvironment = Record<string, string | undefined>;

export function resolveOpensteerEnvironment(
  cwd: string = process.cwd(),
  baseEnv: NodeJS.ProcessEnv = process.env,
): OpensteerEnvironment {
  const resolved = collectOpensteerEnvironment(baseEnv);
  const protectedKeys = new Set(Object.keys(resolved));
  const directories = collectDirectories(cwd);

  for (const directory of directories) {
    for (const filename of ENV_FILENAMES) {
      const filePath = path.join(directory, filename);
      if (!existsSync(filePath)) {
        continue;
      }
      let contents: string;
      try {
        contents = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseEnvFile(contents);
      for (const [key, value] of Object.entries(parsed)) {
        if (!isOpensteerEnvironmentKey(key) || protectedKeys.has(key)) {
          continue;
        }
        resolved[key] = value;
      }
    }
  }

  return resolved;
}

export function loadOpensteerEnvironment(cwd: string = process.cwd()): void {
  const resolved = resolveOpensteerEnvironment(cwd);
  for (const [key, value] of Object.entries(resolved)) {
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
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

export function parseEnvFile(contents: string): Record<string, string> {
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
  if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }

  if (rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }

  return rawValue.replace(/\s+#.*$/u, "").trimEnd();
}

function collectOpensteerEnvironment(baseEnv: NodeJS.ProcessEnv): OpensteerEnvironment {
  const resolved: OpensteerEnvironment = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!isOpensteerEnvironmentKey(key) || value === undefined) {
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function isOpensteerEnvironmentKey(key: string): boolean {
  return key.startsWith(OPENSTEER_ENV_PREFIX);
}
