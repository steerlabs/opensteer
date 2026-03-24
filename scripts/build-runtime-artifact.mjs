import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const packageDir = path.join(repoRoot, "packages", "opensteer");

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir =
  outIndex >= 0 && args[outIndex + 1]
    ? path.resolve(process.cwd(), args[outIndex + 1])
    : path.join(repoRoot, "dist", "runtime-artifact");

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });

await run("pnpm", ["--dir", repoRoot, "--filter", "opensteer", "build"]);
const packDir = path.join(outDir, ".pack");
await rm(packDir, { force: true, recursive: true });
await mkdir(packDir, { recursive: true });
await cp(path.join(packageDir, "dist"), path.join(packDir, "dist"), {
  recursive: true,
});
await copyDirIfExists(path.join(packageDir, "skills"), path.join(packDir, "skills"));
await copyIfExists(path.join(packageDir, "README.md"), path.join(packDir, "README.md"));
await writeFile(
  path.join(packDir, "package.json"),
  JSON.stringify(await createRuntimePackageManifest(), null, 2) + "\n",
  "utf8",
);

const { stdout } = await run("npm", ["pack", "--pack-destination", outDir], {
  cwd: packDir,
});
const tarballName = stdout
  .trim()
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".tgz"))
  .at(-1);

if (!tarballName) {
  throw new Error("Failed to determine runtime tarball filename.");
}

process.stdout.write(`${path.join(outDir, tarballName)}\n`);

async function createRuntimePackageManifest() {
  const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));

  return {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    license: packageJson.license,
    type: packageJson.type,
    sideEffects: packageJson.sideEffects,
    engines: packageJson.engines,
    main: packageJson.main,
    module: packageJson.module,
    types: packageJson.types,
    bin: packageJson.bin,
    exports: packageJson.exports,
    files: ["dist", "skills", "README.md"],
    dependencies: packageJson.dependencies,
  };
}

async function copyIfExists(source, target) {
  try {
    await access(source);
  } catch {
    return;
  }

  await copyFile(source, target);
}

async function copyDirIfExists(source, target) {
  try {
    await access(source);
  } catch {
    return;
  }

  await cp(source, target, { recursive: true });
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
        stderr += chunk.toString();
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${commandArgs.join(" ")} failed with exit code ${String(code)}.${stderr ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}
