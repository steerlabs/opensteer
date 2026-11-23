import type { AutomationScript, TriggerSystemRole } from "@opensteer/triggers";

/**
 * T13: Memory passes are ordinary one-line automation scripts calling `opensteer_task_send`.
 * Admission owns liveness, 2-hour quiet skip (bypassed for manual runs), and deduplication.
 * Uses bundled Node.js ESM (`interpreter: null`) so it runs identically on macOS, Linux, and Windows.
 */
export function memoryPassScript(role: TriggerSystemRole): AutomationScript {
  const label = role === "memory-light" ? "Light" : "Nightly";
  const reference = role === "memory-light" ? "light-pass" : "nightly";
  const prefix = `${label} pass due (`;
  const suffix = `). Load opensteer:memory and follow its ${reference} reference.`;
  return {
    interpreter: null,
    text: `import { readFileSync } from "node:fs"; import { execFileSync } from "node:child_process"; const e = JSON.parse(readFileSync(process.env.OPENSTEER_EVENT_PATH, "utf8")); execFileSync("opensteer", ["tool", "opensteer_task_send", "--json", JSON.stringify({ delivery: "queue", taskId: e.trigger.anchorThreadId, message: ${JSON.stringify(prefix)} + (e.source.scheduledFor ?? e.receivedAt) + ${JSON.stringify(suffix)} })], { stdio: "inherit" });\n`,
  };
}
