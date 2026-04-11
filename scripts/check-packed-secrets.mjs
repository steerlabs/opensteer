import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishPackageDirs = [
  "packages/browser-core",
  "packages/protocol",
  "packages/runtime-core",
  "packages/engine-playwright",
  "packages/engine-abp",
  "packages/opensteer",
];
const suspiciousFilenamePattern =
  /(^|\/)(\.env(?:\.|$)?|\.npmrc|id_rsa|id_dsa|.*\.(pem|key|p12|pfx|crt))$/i;
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opensteer-pack-secrets-"));

try {
  const localSecrets = await readLocalSecrets();
  const findings = [];

  for (const relativePackageDir of publishPackageDirs) {
    const packageDir = path.join(repoRoot, relativePackageDir);
    const tarballPath = await packPackage(packageDir, tempRoot);
    findings.push(...(await inspectTarball(relativePackageDir, tarballPath, localSecrets)));
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`secret-check: ${finding}`);
    }
    process.exitCode = 1;
  } else {
    console.log("packed tarballs contain no detected local secrets or sensitive files");
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function readLocalSecrets() {
  const envPath = path.join(repoRoot, ".env");
  try {
    const envText = await readFile(envPath, "utf8");
    return envText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) {
          return undefined;
        }
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!/(api[_-]?key|token|secret|password|passwd)/iu.test(name)) {
          return undefined;
        }
        if (value.trim().length < 8) {
          return undefined;
        }
        return { name, value };
      })
      .filter((entry) => entry !== undefined);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function inspectTarball(label, tarballPath, localSecrets) {
  const unpackDir = path.join(tempRoot, label.replace(/\//gu, "-"));
  await mkdir(unpackDir, { recursive: true });
  await runCommand("tar", ["-xzf", tarballPath, "-C", unpackDir], repoRoot);
  const packageRoot = path.join(unpackDir, "package");
  const relativeFiles = (await walkFiles(packageRoot)).map((filePath) => ({
    absolute: filePath,
    relative: path.relative(packageRoot, filePath),
  }));
  const findings = [];

  for (const file of relativeFiles) {
    if (suspiciousFilenamePattern.test(file.relative)) {
      findings.push(`${label}: packed suspicious filename "${file.relative}"`);
    }
  }

  for (const file of relativeFiles) {
    let content;
    try {
      content = await readFile(file.absolute, "utf8");
    } catch {
      continue;
    }

    if (privateKeyPattern.test(content)) {
      findings.push(`${label}: packed private key material in "${file.relative}"`);
    }

    for (const secret of localSecrets) {
      if (content.includes(secret.value)) {
        findings.push(
          `${label}: packed value from local env "${secret.name}" in "${file.relative}"`,
        );
      }
    }
  }

  return findings;
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function packPackage(packageDir, outDir) {
  await stat(packageDir);
  const { stdout } = await runCommand("pnpm", ["pack", "--pack-destination", outDir], packageDir);
  const tarballName = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  if (!tarballName) {
    throw new Error(`Failed to determine tarball filename for ${packageDir}.`);
  }
  return path.isAbsolute(tarballName) ? tarballName : path.join(outDir, tarballName);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${String(code)}.${stderr ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}
