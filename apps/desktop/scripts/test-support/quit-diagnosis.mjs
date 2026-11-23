// Appends to an Electron journey's results.jsonl one short row per quit --tab-restore run:
// whether a trial failed and with what, and for a failed drag the sidebar as the trial saw it.
// Usage: node scripts/test-support/quit-diagnosis.mjs <electron journey out directory>
import fs from "node:fs";
import path from "node:path";
const out = process.argv[2];
const quit = path.join(out, "quit");
const rows = [];
const short = (value, length) => String(value).slice(0, length);
// Every id by its last four characters: a row's motion key, a selector, a sidebar entry.
const key = (value) => String(value).replace(/["\]]/gu, "").slice(-4);
for (const [index, run] of fs
  .readdirSync(quit)
  .filter((name) => name.startsWith("quit-"))
  .sort()
  .entries()) {
  const data = path.join(quit, run, "data");
  const files = fs.existsSync(data) ? fs.readdirSync(data) : [];
  const failed = files
    .filter((name) => name.endsWith(".jsonl") && !name.includes("inputs"))
    .flatMap((name) => fs.readFileSync(path.join(data, name), "utf8").split("\n"))
    .find((line) => line.includes('"test.failed"'));
  const state = path.join(data, "tab-restore-state.json");
  if (fs.existsSync(state)) {
    const ids = JSON.parse(fs.readFileSync(state, "utf8"));
    rows.push({ name: "ids", run: index, p1: key(ids.p1), pop: key(ids.pop), f1: key(ids.f1) });
  }
  rows.push({
    name: "quit-run",
    run: index,
    failed: failed ? short(JSON.parse(failed).error, 150) : null,
  });
  for (const name of files.filter((name) => name.endsWith(".drag-failed.json"))) {
    const record = JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));
    rows.push({
      name: "drag",
      run: index,
      drag: key(record.drag),
      shown: (record.shown ?? []).map(key),
    });
    for (const entry of record.log ?? [])
      if (entry[1] === "lifted" || entry[1] === "before-up")
        rows.push({
          name: entry[1],
          run: index,
          list: entry.slice(2, 4),
          rows: (entry.at(-1) ?? []).map((row) => [key(row[0]), row[1]].join("@")),
        });
  }
}
fs.appendFileSync(
  path.join(out, "results.jsonl"),
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
