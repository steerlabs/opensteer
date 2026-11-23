import { readdirSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionContainment, executionScopeVariable } from "./execution-containment.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

afterEach(() => vi.useRealTimers());

it("keeps an orphan's identity until reaping when Linux has already removed its environment", async () => {
  vi.useFakeTimers();
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  let state: "running" | "zombie" | "reaped" = "running";
  const stat = (pid: number, ppid: number) =>
    `${pid} (engine child) ${state === "zombie" ? "Z" : "S"} ${ppid} ${Array(17).fill(0).join(" ")} 123`;
  vi.mocked(readdirSync).mockImplementation(
    () => (state === "running" ? ["101", "102"] : state === "zombie" ? ["102"] : []) as never,
  );
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path).endsWith("/stat"))
      return (
        String(path).includes("/101/") ? stat(101, 1) : stat(102, state === "running" ? 101 : 1)
      ) as never;
    if (state === "zombie") throw Object.assign(new Error("No address space"), { code: "ESRCH" });
    return (
      String(path).includes("/101/")
        ? `${executionScopeVariable}=${containment.scope("run")}\0`
        : ""
    ) as never;
  });
  vi.spyOn(process, "kill").mockImplementation(() => true);
  let settled = false;
  const stopping = containment
    .terminate("run", async () => {
      state = "zombie";
    })
    .then((proof) => {
      settled = true;
      return proof;
    });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled, "an unreaped owned PID cannot be proof of an empty execution").toBe(false);
  state = "reaped";
  await vi.advanceTimersByTimeAsync(100);
  await expect(stopping).resolves.toBe("proven");
});
