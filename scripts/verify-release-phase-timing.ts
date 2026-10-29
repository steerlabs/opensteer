import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timedCommands } from "./command-runner.js";

const directory = await mkdtemp(
  path.join(
    process.env.OPENSTEER_PHASE_F_EVIDENCE_DIRECTORY ?? tmpdir(),
    "opensteer-phase-timing-",
  ),
);
const filename = path.join(directory, "commands.jsonl");
const modulePath = fileURLToPath(new URL("./release-phase-timing.cjs", import.meta.url));
const run = timedCommands(filename);
await run(
  process.execPath,
  [
    "-e",
    `const { timePhase } = require(${JSON.stringify(modulePath)}); (async () => { await timePhase('package.resource-prep', async () => timePhase('package.tsup', async () => {})); try { await timePhase('runtime.sign', async () => { throw Error('secret-value'); }); } catch {} })();`,
  ],
  { env: { SECRET_TOKEN: "secret-value" } },
);
const events = (await readFile(filename, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
for (const phase of ["package.resource-prep", "package.tsup", "runtime.sign"]) {
  const pair = events.filter((event) => event.phase === phase);
  assert.deepEqual(
    pair.map((event) => event.event),
    ["start", phase === "runtime.sign" ? "failed" : "complete"],
  );
  assert.equal(pair[0].id, pair[1].id);
  assert.equal(typeof pair[0].parentId, "string");
  assert.ok(pair[1].elapsedMs >= 0);
}
assert.equal((await readFile(filename, "utf8")).includes("secret-value"), false);
const require = createRequire(import.meta.url);
const { timePhase } = require(modulePath);
await assert.rejects(
  timePhase("argument with secrets", async () => {}),
  /phase/u,
);
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify({ passed: true, filename }, null, 2),
);
process.stdout.write(`${directory}\n`);
