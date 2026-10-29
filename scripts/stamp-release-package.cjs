const { lstatSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const [manifestArgument] = process.argv.slice(2);
if (!manifestArgument) throw new Error("usage: stamp-release-package.cjs <package.json>");
const version = process.env.OPENSTEER_RELEASE_VERSION;
const sourceRevision = process.env.OPENSTEER_SOURCE_REVISION;
if (
  !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version ?? "") ||
  version.length > 79 ||
  version === "0.0.0" ||
  !/^[0-9a-f]{40}$/u.test(sourceRevision ?? "") ||
  sourceRevision === "0".repeat(40)
) {
  throw new Error("A real Opensteer release version and exact source revision are required.");
}
const manifestPath = resolve(manifestArgument);
const metadata = lstatSync(manifestPath);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error("Release package manifest must be a real regular file.");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.opensteerBuild = { sourceRevision, version };
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
