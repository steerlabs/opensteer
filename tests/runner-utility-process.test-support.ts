import { EventEmitter } from "node:events";
import type { Serializable } from "node:child_process";

// Exercise the shipped Electron worker in a real Node child without a GUI.
// Only the parentPort transport is adapted; the Runner daemon is unchanged.
const parent = Object.assign(new EventEmitter(), {
  postMessage(value: Serializable): void {
    process.send?.(value, () => {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        (value.type === "runner.worker.stopped" || value.type === "runner.worker.failed")
      ) {
        process.disconnect?.();
      }
    });
  },
});
process.parentPort = parent;
const queued: unknown[] = [];
let loaded = false;
process.on("message", (data) => {
  if (!loaded) queued.push(data);
  else deliver(data);
});
function deliver(data: unknown): void {
  parent.emit("message", { data });
  if (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "runner.worker.secrets"
  ) {
    process.send?.({ type: "fixture.credentials-received" });
  }
}
const worker = process.argv[2];
if (!worker) throw new Error("Missing Runner worker entrypoint");
await import(worker);

loaded = true;
for (const data of queued) deliver(data);
