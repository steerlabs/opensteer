// Summarizes the real-host bench's JSONL as median / p95 / min / max / n, per kind and tier.
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function stats(values) {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!sorted.length) return "—";
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const f = (value) =>
    value >= 100 ? Math.round(value).toLocaleString("en-US") : value.toFixed(1);
  return `${f(at(0.5))} / ${f(at(0.95))} / ${f(sorted[0])} / ${f(sorted.at(-1))} / ${sorted.length}`;
}

const groups = new Map();
for (const row of rows) {
  const key = row.kind === "wake" || row.kind === "clock" ? `${row.kind} ${row.tier}` : row.kind;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

console.log(
  "| Series | first CDP reply (ms) | original tab (ms) | edited frame (ms) | agent call (ms) | save (ms) | all checks |",
);
console.log("|---|---|---|---|---|---|---|");
for (const [key, group] of groups) {
  if (
    !["cold", "wake", "clock", "concurrent-wake", "after-concurrent-save"].some((kind) =>
      key.startsWith(kind),
    )
  )
    continue;
  const passed = group.filter((row) => row.passed !== false).length;
  console.log(
    `| ${key} | ${stats(group.map((row) => row.cdp_ms))} | ${stats(group.map((row) => row.same_tab_ms))} | ${stats(
      group.map((row) => row.edited_frame_ms),
    )} | ${stats(group.map((row) => row.resume_call_ms ?? row.start_call_ms))} | ${stats(
      group.map((row) => row.save_ms),
    )} | ${passed}/${group.length} |`,
  );
}
for (const row of rows.filter((entry) => entry.kind === "clock"))
  console.log(
    `clock ${row.tier}: slept ${row.slept_ms} ms, guest behind ${row.guest_behind_ms} ms, clocksource ${row.clocksource}`,
  );
for (const row of rows.filter((entry) => entry.kind === "concurrent-save"))
  console.log(`concurrent save round ${row.round} ${row.slot}: ${row.save_ms} ms`);
console.log("\nIsolation:");
for (const row of rows.filter((entry) => entry.kind === "isolation"))
  console.log(
    `- ${row.ok ? "ok  " : "FAIL"} from ${row.from}: ${row.what} ${row.host ?? ""}${row.port ? `:${row.port}` : ""} → ${row.result} (want ${row.want})`,
  );
console.log("\nAgent restarts:");
for (const row of rows.filter((entry) => entry.kind === "restart" || entry.kind === "restart-save"))
  console.log(
    `- ${row.kind} ${row.point}: ${JSON.stringify({ ...row, at: undefined, kind: undefined, point: undefined })}`,
  );
const failures = rows.filter((row) => row.kind === "failed");
if (failures.length) console.log(`\nFailed: ${failures.map((row) => row.message).join("\n")}`);
const https = rows.filter((row) => row.https !== undefined);
console.log(
  `\nHTTPS after wake through the host-side egress proxy: ${https.filter((row) => row.https === "opaque").length}/${https.length}`,
);
