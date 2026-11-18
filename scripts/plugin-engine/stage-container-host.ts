import { createRequire } from "node:module";
import { access, cp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stageSharpRuntime } from "../../apps/desktop/scripts/build-personal-runtime.js";
import { stagePluginEngineRuntime } from "./stage-runtime.js";

const output = resolve(process.argv[2]!);
if (output === process.cwd() || !process.argv[2])
  throw new Error("A deployed Host directory is required");
const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8")) as {
  name?: string;
};
if (manifest.name !== "@opensteer/host") throw new Error("Expected a deployed Host package");
await access(join(output, "dist/main.js"));
// nodeApp bundles the workspace graph. Only its declared external runtime packages survive.
await rm(join(output, "node_modules"), { recursive: true, force: true });
const modules = "dist/node_modules";
await stagePluginEngineRuntime(join(output, modules), process.platform, process.arch);
if (!["darwin", "linux", "win32"].includes(process.platform))
  throw new Error("Unsupported Host target");
await stageSharpRuntime(
  output,
  process.platform as "darwin" | "linux" | "win32",
  process.arch === "x64" ? "amd64" : "arm64",
  modules,
);
const hostRequire = createRequire(new URL("../../apps/host/package.json", import.meta.url));
const zod = dirname(await realpath(hostRequire.resolve("zod/package.json")));
await cp(zod, join(output, modules, "zod"), {
  recursive: true,
  filter: (source) => !/\.(?:[cm]?ts|map)$/u.test(source) && !source.includes("/src/"),
});
for (const file of await readdir(join(output, "dist")))
  if (file.endsWith(".map")) await rm(join(output, "dist", file));
