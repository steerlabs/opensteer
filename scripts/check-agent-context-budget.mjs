// The PR gate runs this with bare Node before any dependency install, so it
// may import only Node built-ins.
import { readFileSync } from "node:fs";

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
  if (!Object.hasOwn(current, key)) changes.push(`${key}: removed or renamed`);
  else if (current[key] > value) changes.push(`${key}: ${value} -> ${current[key]}`);
}
for (const [key, value] of Object.entries(current)) {
  if (!Object.hasOwn(baseline, key) && value > 0) changes.push(`${key}: new metric -> ${value}`);
}
if (changes.length) {
  console.log(`Agent context changed compared with origin/main:\n${changes.join("\n")}`);
  if (process.env.ALLOW_INCREASE !== "true") {
    console.error("Reduce the context or obtain the agent-context-increase PR label.");
    process.exitCode = 1;
  }
} else {
  console.log("Agent context did not grow; all baseline keys remain.");
}
