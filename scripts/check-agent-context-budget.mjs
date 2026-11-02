// Reports how model-visible context changed against main; it never blocks a PR.
// CI runs it with bare Node before any dependency install, so it may import only
// Node built-ins.
import { appendFileSync, readFileSync } from "node:fs";

function readMetrics(path) {
  const metrics = JSON.parse(readFileSync(path, "utf8"));
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error(`${path} must hold one object of metrics`);
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${path}: ${key} must be a non-negative integer`);
    }
  }
  return metrics;
}

const baseline = readMetrics(process.argv[2]);
const current = readMetrics(process.argv[3]);
const changes = [];
for (const [key, value] of Object.entries(baseline)) {
  if (!Object.hasOwn(current, key)) changes.push(`${key}: removed or renamed (was ${value})`);
  else if (current[key] !== value) {
    const delta = current[key] - value;
    changes.push(`${key}: ${value} -> ${current[key]} (${delta > 0 ? "+" : ""}${delta})`);
  }
}
for (const [key, value] of Object.entries(current)) {
  if (!Object.hasOwn(baseline, key)) changes.push(`${key}: new metric -> ${value}`);
}
const report = changes.length
  ? `Agent context changed compared with main:\n${changes.join("\n")}`
  : "Agent context is unchanged from main.";
console.log(report);
// Shown on the run's summary page so reviewers see growth without reading logs.
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Agent context\n\n\`\`\`\n${report}\n\`\`\`\n`,
  );
