import { setFileMode } from "@opensteer/shared/privateFiles";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PluginRuntimeFile {
  readonly path: string;
  readonly mode: "code" | "data" | "executable";
}

export function workerdPackage(platform: string, architecture: string): string | undefined {
  const suffix = architecture === "amd64" || architecture === "x64" ? "64" : architecture;
  if ((platform === "darwin" || platform === "linux") && ["64", "arm64"].includes(suffix))
    return `@cloudflare/workerd-${platform}-${suffix}`;
  return platform === "win32" && suffix === "64" ? "@cloudflare/workerd-windows-64" : undefined;
}

/** Only files read at runtime: no compiler CLI, declaration libraries, source maps or installers. */
export async function stagePluginEngineRuntime(
  modules: string,
  platform: string,
  architecture: string,
): Promise<readonly PluginRuntimeFile[]> {
  const hostRequire = createRequire(new URL("../../apps/host/package.json", import.meta.url));
  const files: PluginRuntimeFile[] = [];
  const copy = async (source: string, destination: string, mode: PluginRuntimeFile["mode"]) => {
    const target = join(modules, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await setFileMode(target, mode === "executable" ? 0o755 : 0o644);
    files.push({ path: destination, mode });
  };
  const packageRoot = async (name: string) =>
    dirname(await realpath(hostRequire.resolve(`${name}/package.json`)));
  const select = async (name: string, paths: readonly string[]) => {
    const source = await packageRoot(name);
    for (const file of paths)
      await copy(join(source, file), `${name}/${file}`, /\.[cm]?js$/u.test(file) ? "code" : "data");
  };
  await select("workerd", ["package.json", "lib/main.js"]);
  const binaryPackage = workerdPackage(platform, architecture);
  if (binaryPackage) {
    const workerdRequire = createRequire(hostRequire.resolve("workerd/package.json"));
    const source = dirname(await realpath(workerdRequire.resolve(`${binaryPackage}/package.json`)));
    for (const name of await readdir(source)) {
      if (name === "bin") {
        const executable = `bin/workerd${platform === "win32" ? ".exe" : ""}`;
        await copy(join(source, executable), `${binaryPackage}/${executable}`, "executable");
      } else if (["package.json", "README.md", "LICENSE"].includes(name)) {
        await copy(join(source, name), `${binaryPackage}/${name}`, "data");
      }
    }
  }
  await select("typescript-5", [
    "package.json",
    "lib/typescript.js",
    "LICENSE.txt",
    "ThirdPartyNoticeText.txt",
  ]);
  const ws = await packageRoot("ws");
  await select("ws", ["package.json", "index.js", "wrapper.mjs", "LICENSE"]);
  for (const name of await readdir(join(ws, "lib")))
    if (name.endsWith(".js")) await copy(join(ws, "lib", name), `ws/lib/${name}`, "code");
  const wrapper = "@alchemy.run/cloudflare-runtime";
  const source = await packageRoot(wrapper);
  await select(wrapper, ["package.json", "NOTICE", "THIRD_PARTY_LICENSES.md"]);
  const workers = join(source, "dist/core/workers");
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(?:mjs|wasm)$/u.test(entry.name))
        await copy(
          file,
          `${wrapper}/${relative(source, file).split("\\").join("/")}`,
          entry.name.endsWith(".mjs") ? "code" : "data",
        );
    }
  };
  await walk(workers);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const modules = resolve(process.argv[2]!);
  const files = await stagePluginEngineRuntime(modules, process.platform, process.arch);
  // Deployment builds use this inventory to verify that native selection was not pruned.
  const bytes = await Promise.all(
    files.map(async (file) => (await readFile(join(modules, file.path))).length),
  );
  process.stdout.write(
    `${files.length} plugin runtime files, ${bytes.reduce((sum, size) => sum + size, 0)} bytes\n`,
  );
}
