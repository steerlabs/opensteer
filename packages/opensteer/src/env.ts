import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILENAMES = [".env", ".env.local"] as const;
const OPENSTEER_ENV_PREFIX = "OPENSTEER_";

interface CachedOpensteerEnvironment {
  readonly signature: string;
  readonly values: OpensteerEnvironment;
}

export type OpensteerEnvironment = Record<string, string | undefined>;
const opensteerEnvironmentCache = new Map<string, CachedOpensteerEnvironment>();

export function resolveOpensteerEnvironment(
  cwd: string = process.cwd(),
  baseEnv: NodeJS.ProcessEnv = process.env,
): OpensteerEnvironment {
  const resolvedCwd = path.resolve(cwd);
  const signature = buildEnvironmentSignature(baseEnv, isOpensteerEnvironmentKey);
  const cached = opensteerEnvironmentCache.get(resolvedCwd);
  if (cached && cached.signature === signature) {
    return { ...cached.values };
  }

  const resolved = resolveEnvironmentFiles(resolvedCwd, baseEnv, isOpensteerEnvironmentKey);
  opensteerEnvironmentCache.set(resolvedCwd, {
    signature,
    values: { ...resolved },
  });
  return { ...resolved };
}

export function loadEnvironment(cwd: string = process.cwd()): void {
  const resolved = resolveEnvironmentFiles(path.resolve(cwd), process.env);
  for (const [key, value] of Object.entries(resolved)) {
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

function resolveEnvironmentFiles(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  predicate?: (key: string) => boolean,
): OpensteerEnvironment {
  const resolved = collectEnvironment(baseEnv, predicate);
  const protectedKeys = new Set(Object.keys(resolved));
  const directories = collectDirectories(cwd);

  for (const directory of directories) {
    for (const filename of ENV_FILENAMES) {
      const filePath = path.join(directory, filename);
      if (!existsSync(filePath)) {
        continue;
      }
      const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if ((predicate && !predicate(key)) || protectedKeys.has(key)) {
          continue;
        }
        resolved[key] = value;
      }
    }
  }

  return resolved;
}

function collectEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  predicate?: (key: string) => boolean,
): OpensteerEnvironment {
  const resolved: OpensteerEnvironment = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if ((predicate && !predicate(key)) || value === undefined) {
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function buildEnvironmentSignature(
  baseEnv: NodeJS.ProcessEnv,
  predicate: (key: string) => boolean,
): string {
  return Object.entries(baseEnv)
    .filter(([key, value]) => predicate(key) && value !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function isOpensteerEnvironmentKey(key: string): boolean {
  return key.startsWith(OPENSTEER_ENV_PREFIX);
}
