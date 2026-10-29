const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Read shipped harness artifact modes from the typed catalog without keeping a
 * second engine list in electron-builder's CommonJS hooks.
 */
function shippedHarnessArtifactModes() {
  const esbuild = require("esbuild");
  const source = join(__dirname, "../../../packages/core/src/harness-catalog.ts");
  const { code } = esbuild.transformSync(readFileSync(source, "utf8"), {
    format: "cjs",
    loader: "ts",
    platform: "node",
  });
  const transpiled = { exports: {} };
  new Function("module", "exports", code)(transpiled, transpiled.exports);
  const catalog = transpiled.exports.harnessCatalog;
  const kinds = transpiled.exports.shippedHarnessKinds;
  if (!Array.isArray(catalog) || !Array.isArray(kinds) || kinds.length === 0) {
    throw new Error("The harness catalog declares no engines to ship.");
  }
  const modes = {};
  for (const kind of kinds) {
    const entry = catalog.find((candidate) => candidate.kind === kind);
    if (!entry) throw new Error(`The harness catalog has no entry for ${kind}.`);
    modes[kind] = entry.runtime.shape === "script" ? "code" : "executable";
  }
  return modes;
}

module.exports = { shippedHarnessArtifactModes };
