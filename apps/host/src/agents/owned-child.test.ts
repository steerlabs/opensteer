import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { ownChild } from "./owned-child.test-support.js";

it("joins a delayed exit and escalates cancellation before readiness", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')",
  ]);
  const owner = ownChild(child);
  try {
    await once(child.stdout!, "data");
    await owner.close(() => {
      child.kill("SIGTERM");
    }, 20);
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    child.kill("SIGKILL");
    await owner.exited;
  }
});

it("joins an already exited child", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "close");
  await ownChild(child).close(() => {
    throw new Error("already stopped");
  });
});

it("surfaces failed spawn without waiting for an exit that never arrives", async () => {
  const child = spawn("/opensteer-missing-test-executable");
  const owner = ownChild(child);
  await expect(owner.close(() => {})).rejects.toThrow("Owned child cleanup failed");
});
