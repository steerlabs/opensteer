import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MacPreparationPool, runMacPreparations } from "./mac-preparation.js";
import { runBounded } from "./command-runner.js";

const directory = await mkdtemp(
  path.join(
    process.env.OPENSTEER_PHASE_F_EVIDENCE_DIRECTORY ?? tmpdir(),
    "opensteer-mac-preparation-",
  ),
);
for (const failure of [false, true]) {
  const trace = path.join(directory, failure ? "failure.jsonl" : "success.jsonl");
  const worker =
    (name: string, fail = false) =>
    async (signal: AbortSignal) => {
      await runBounded(
        process.execPath,
        [
          "-e",
          `const fs=require('node:fs'); const event=event=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,name:${JSON.stringify(name)},pid:process.pid,at:Date.now()})+'\\n'); event('start'); process.on('SIGTERM',()=>{event('canceled');process.exit(0)});setTimeout(()=>{event(${JSON.stringify(fail ? "failed" : "complete")});process.exit(${fail ? 42 : 0})},${fail ? 300 : 1000});`,
        ],
        { signal },
      );
    };
  const result = runMacPreparations([
    worker("runtime", failure),
    worker("broker"),
    worker("phone"),
  ]);
  if (failure) await assert.rejects(result, /exit 42/u);
  else await result;
  const events = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.event === "start" ? 1 : -1;
    maximum = Math.max(maximum, active);
    if (event.event === "start") assert.throws(() => process.kill(event.pid, 0), /ESRCH/u);
  }
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  if (failure) {
    assert.ok(events.some((event) => event.name === "broker" && event.event === "canceled"));
    assert.equal(
      events.some((event) => event.name === "phone"),
      false,
    );
  } else assert.equal(events.filter((event) => event.event === "complete").length, 3);
}
// A compiler can exit on TERM while a compiler grandchild ignores it and has
// closed its inherited pipes. Joining only the direct child is insufficient.
const descendants = path.join(directory, "descendants.jsonl");
let cleanupFailure: unknown;
try {
  const pool = new MacPreparationPool();
  const phone = pool.run(async (signal) => {
    await runBounded(process.execPath, ["-e", "setTimeout(()=>process.exit(42),500)"], {
      signal,
    });
  });
  const compiler = runMacPreparations(
    [
      async (signal) => {
        await runBounded(
          process.execPath,
          [
            "-e",
            `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.appendFileSync(${JSON.stringify(descendants)},JSON.stringify({pid:child.pid})+'\\n');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
          ],
          { signal },
        );
      },
    ],
    undefined,
    pool,
  );
  const outcomes = await Promise.allSettled([phone, compiler]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /exit 42/u);
  }
  for (const line of (await readFile(descendants, "utf8")).trim().split("\n")) {
    const { pid } = JSON.parse(line);
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  }
} finally {
  for (const line of (await readFile(descendants, "utf8")).trim().split("\n")) {
    try {
      process.kill(JSON.parse(line).pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        cleanupFailure = error;
    }
  }
}
if (cleanupFailure) throw cleanupFailure;
await writeFile(
  path.join(directory, "report.json"),
  JSON.stringify({ passed: true, concurrency: 2, cancellationJoined: true }, null, 2),
);
process.stdout.write(`${directory}\n`);
