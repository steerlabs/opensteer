const { deepStrictEqual } = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const [source, deployed] = process.argv.slice(2);
if (!source || !deployed)
  throw new Error(
    "Usage: verify-deployed-package.cjs <source-package.json> <deployed-package.json>",
  );
// Stamp generation uses this small source manifest independently of the large
// build output. Fail before publication if pnpm ever changes its deploy format.
deepStrictEqual(JSON.parse(readFileSync(deployed)), JSON.parse(readFileSync(source)));
