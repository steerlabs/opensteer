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
  const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
    if (sig === 0 && state === "reaped") {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    }
    return true;
  });
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
  killSpy.mockRestore();
});

it("A1(a) case 1: returns unverifiable when a candidate child process environ is unreadable (EACCES)", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  const uid = process.getuid?.() ?? 1000;
  vi.mocked(readdirSync).mockImplementation(() => ["201"] as never);
  vi.mocked(readFileSync).mockImplementation((path) => {
    const target = String(path);
    if (target === "/proc/201/stat") {
      return `201 (setuid-helper) S ${process.pid} ${Array(17).fill(0).join(" ")} 456` as never;
    }
    if (target === "/proc/201/status") {
      return `Name:\tsetuid-helper\nUid:\t${uid}\t0\t0\t0\n` as never;
    }
    if (target === "/proc/201/environ") {
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  await expect(containment.terminate("run")).resolves.toBe("unverifiable");
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("A1(a) case 2: returns unverifiable when a listed process vanishes between listing and reading", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  vi.mocked(readdirSync).mockImplementation(() => ["202"] as never);
  vi.mocked(readFileSync).mockImplementation(() => {
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  });
  await expect(containment.terminate("run")).resolves.toBe("unverifiable");
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("A1(a) case 3: returns unverifiable when the process listing is truncated or malformed", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  vi.mocked(readdirSync).mockImplementation(() => ["203"] as never);
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path) === "/proc/203/environ") return "" as never;
    if (String(path) === "/proc/203/stat") return "203 (truncated" as never;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  await expect(containment.terminate("run")).resolves.toBe("unverifiable");
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("A1(a) case 4: returns unverifiable when a child seen earlier disappears while still alive under another privilege (EPERM)", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  let phase: "seen" | "vanished-from-listing" = "seen";
  vi.mocked(readdirSync).mockImplementation(() => (phase === "seen" ? ["204"] : []) as never);
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path) === "/proc/204/stat") {
      return `204 (worker) S 1 ${Array(17).fill(0).join(" ")} 789` as never;
    }
    if (String(path) === "/proc/204/environ") {
      return `${executionScopeVariable}=${containment.scope("run")}\0` as never;
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (pid === 204 && sig === 0 && phase === "vanished-from-listing") {
      throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    }
    return true;
  });
  try {
    await containment.note("run");
    phase = "vanished-from-listing";
    await expect(containment.terminate("run")).resolves.toBe("unverifiable");
  } finally {
    killSpy.mockRestore();
  }
});

it("does not fail a scan when an already-exited zombie direct child returns EACCES on /proc/<pid>/environ", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  vi.mocked(readdirSync).mockImplementation(() => ["205"] as never);
  vi.mocked(readFileSync).mockImplementation((path) => {
    const target = String(path);
    if (target === "/proc/205/stat") {
      return `205 (opensteer-proce) Z ${process.pid} ${Array(17).fill(0).join(" ")} 999` as never;
    }
    if (target === "/proc/205/environ") {
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  await expect(containment.reapEarlierBoots()).resolves.toBe("proven");
  await expect(containment.liveRoots("run")).resolves.toBe(0);
});

it("V2 (A3): an unrelated setuid process of the person's user does not make a clean Stop unverifiable", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  const uid = process.getuid?.() ?? 1000;
  let memberAlive = true;
  vi.mocked(readdirSync).mockImplementation(
    () => (memberAlive ? ["301", "900"] : ["900"]) as never,
  );
  vi.mocked(readFileSync).mockImplementation((path) => {
    const target = String(path);
    if (target === "/proc/301/stat")
      return `301 (engine) S ${process.pid} ${Array(17).fill(0).join(" ")} 111` as never;
    if (target === "/proc/301/environ")
      return `${executionScopeVariable}=${containment.scope("run")}\0` as never;
    if (target === "/proc/900/stat")
      return `900 (fusermount3) S 1 ${Array(17).fill(0).join(" ")} 222` as never;
    if (target === "/proc/900/status")
      return `Name:\tfusermount3\nUid:\t${uid}\t0\t0\t0\n` as never;
    if (target === "/proc/900/environ")
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (pid === 301 && sig === 0 && !memberAlive)
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
  try {
    await containment.note("run");
    const proof = containment.terminate("run", async () => {
      memberAlive = false;
    });
    expect({ stop: await proof, earlierBoots: await containment.reapEarlierBoots() }).toEqual({
      stop: "proven",
      earlierBoots: "proven",
    });
  } finally {
    killSpy.mockRestore();
  }
});

it("V2: ignores unrelated hidepid / other-scope unreadable processes, but fails unverifiable on an unreadable child of a member", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  // Unrelated hidepid (stat EPERM) and a setuid child of a DIFFERENT scope (401 -> 402)
  // do not poison "run".
  vi.mocked(readdirSync).mockImplementation(() => ["401", "402", "901"] as never);
  vi.mocked(readFileSync).mockImplementation((path) => {
    const target = String(path);
    if (target === "/proc/401/stat")
      return `401 (other-engine) S ${process.pid} ${Array(17).fill(0).join(" ")} 111` as never;
    if (target === "/proc/401/environ")
      return `${executionScopeVariable}=${containment.scope("other-run")}\0` as never;
    if (target === "/proc/402/stat")
      return `402 (other-setuid) S 401 ${Array(17).fill(0).join(" ")} 112` as never;
    if (target === "/proc/402/environ")
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    if (target === "/proc/901/stat")
      throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  await expect(containment.terminate("run")).resolves.toBe("proven");
  await expect(containment.liveRoots("run")).resolves.toBe(0);

  // Now an unreadable setuid child (502) whose parent (501) is a member of "run"
  // MUST make the scan unverifiable (both while 501 is alive and after 501 is noted).
  vi.mocked(readdirSync).mockImplementation(() => ["501", "502"] as never);
  vi.mocked(readFileSync).mockImplementation((path) => {
    const target = String(path);
    if (target === "/proc/501/stat")
      return `501 (run-engine) S ${process.pid} ${Array(17).fill(0).join(" ")} 201` as never;
    if (target === "/proc/501/environ")
      return `${executionScopeVariable}=${containment.scope("run")}\0` as never;
    if (target === "/proc/502/stat")
      return `502 (run-setuid) S 501 ${Array(17).fill(0).join(" ")} 202` as never;
    if (target === "/proc/502/environ")
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});
