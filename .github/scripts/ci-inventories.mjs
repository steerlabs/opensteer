import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function checkInventories(records, total, lane) {
  if (records.length !== total) throw new Error("Missing shard inventories");
  const seen = new Set();
  let discovered;
  for (let i = 1; i <= total; i++) {
    const r = records.find((r) => r.shard === i);
    if (!r || r.version !== 1 || r.total !== total || r.lane !== lane)
      throw new Error("Invalid shard identity");
    for (const key of ["discovered", "executed"])
      if (
        !Array.isArray(r[key]) ||
        r[key].some((p) => typeof p !== "string" || !p) ||
        new Set(r[key]).size !== r[key].length
      )
        throw new Error("Corrupt inventory");
    if (!r.discovered.length) throw new Error("Empty discovery");
    const canonical = JSON.stringify([...r.discovered].sort());
    if (discovered && discovered !== canonical) throw new Error("Discovery differs between shards");
    discovered = canonical;
    for (const p of r.executed) {
      if (seen.has(p)) throw new Error(`Overlapping shard: ${p}`);
      seen.add(p);
    }
  }
  if (JSON.stringify([...seen].sort()) !== discovered)
    throw new Error("Executed union differs from discovery");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [lane, count, ...files] = process.argv.slice(2);
  checkInventories(
    files.map((f) => JSON.parse(readFileSync(f, "utf8"))),
    Number(count),
    lane,
  );
}
