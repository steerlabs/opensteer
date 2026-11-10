import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const outfile = fileURLToPath(new URL("./dist/agent-helper.js", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "safari17",
  minify: true,
  legalComments: "none",
});

const swiftOutput = process.argv.indexOf("--swift-output");
if (swiftOutput !== -1) {
  const path = process.argv[swiftOutput + 1];
  if (!path) throw new Error("--swift-output requires a path");
  const source = (await readFile(outfile)).toString("base64");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `import Foundation\nenum PhoneBrowserAgentScript {\n  static let source = String(decoding: Data(base64Encoded: "${source}")!, as: UTF8.self)\n}\n`,
  );
}
