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
  vi.useFakeTimers();
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
  const proof = containment.terminate("run");
  await vi.advanceTimersByTimeAsync(3_500);
  await expect(proof).resolves.toBe("unverifiable");
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("A1(a) case 2: returns unverifiable when a listed process vanishes between listing and reading", async () => {
  vi.useFakeTimers();
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  vi.mocked(readdirSync).mockImplementation(() => ["202"] as never);
  vi.mocked(readFileSync).mockImplementation(() => {
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  });
  const proof = containment.terminate("run");
  await vi.advanceTimersByTimeAsync(3_500);
  await expect(proof).resolves.toBe("unverifiable");
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("A1(a) case 3: returns unverifiable when the process listing is truncated or malformed", async () => {
  vi.useFakeTimers();
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
  const proof = containment.terminate("run");
  await vi.advanceTimersByTimeAsync(3_500);
  await expect(proof).resolves.toBe("unverifiable");
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("A1(a) case 4: returns unverifiable when a child seen earlier disappears while still alive under another privilege (EPERM)", async () => {
  vi.useFakeTimers();
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
    const proof = containment.terminate("run");
    await vi.advanceTimersByTimeAsync(3_500);
    await expect(proof).resolves.toBe("unverifiable");
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

it("X1: retries when a member vanishes in each of the first three passes and proves gone on the quiet fourth pass", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
    terminationGraceMs: 100,
  });
  let phase: "note" | "terminate" = "note";
  let terminatePass = 0;
  vi.mocked(readdirSync).mockImplementation(() => {
    if (phase === "note") return ["301", "302", "303"] as never;
    terminatePass += 1;
    if (terminatePass === 1) return ["301"] as never;
    if (terminatePass === 2) return ["302"] as never;
    if (terminatePass === 3) return ["303"] as never;
    return [] as never;
  });
  vi.mocked(readFileSync).mockImplementation((path) => {
    const target = String(path);
    if (phase === "note") {
      const match = /^\/proc\/(30[123])\/(stat|environ)$/u.exec(target);
      if (match) {
        const [, pid, file] = match;
        if (file === "stat") {
          return `${pid} (worker) S ${process.pid} ${Array(17).fill(0).join(" ")} ${pid}` as never;
        }
        return `${executionScopeVariable}=${containment.scope("run")}\0` as never;
      }
    }
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  });
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (sig === 0 && (pid === 301 || pid === 302 || pid === 303)) {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    }
    return true;
  });
  try {
    await containment.note("run");
    phase = "terminate";
    await expect(containment.terminate("run")).resolves.toBe("proven");
    expect(terminatePass).toBe(4);
  } finally {
    killSpy.mockRestore();
  }
});

/*
 * A process that exits between a pass's two reads of it: its stat said running, and its environ
 * is refused because Linux has already cleared its address space. Nothing is decided from a second
 * read: a refused environ makes the pass unsettled and /proc is read again, where a process that
 * was dying is gone or a zombie at its first read. Counting it as a live unreadable process made a
 * warm engine's reuse "unverifiable" whenever a Run's cut SSH command was exiting under the keep
 * check, so the next Run started a new engine and launch directory.
 */

/** A fake /proc whose listing and files may differ by pass, counted by the root listings. */
function fakeProc(
  read: (pass: number) => {
    readonly listing: readonly string[];
    readonly files: Readonly<Record<string, string | NodeJS.ErrnoException["code"]>>;
  },
) {
  let pass = 0;
  vi.mocked(readdirSync).mockImplementation(((path: string) => {
    if (String(path) === "/proc") {
      pass += 1;
      return [...read(pass).listing];
    }
    const listed = read(pass).files[String(path)];
    if (typeof listed === "string") return listed.split(",") as never;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as never);
  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    const value = read(pass).files[String(path)];
    if (value === undefined || ["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(value))
      throw Object.assign(new Error(value ?? "ENOENT"), { code: value ?? "ENOENT" });
    return value;
  }) as never);
  return { passes: () => pass };
}
/** The kernel's answer to kill(pid, 0): these pids exist no longer; any other does. */
function onlyGone(...pids: number[]) {
  return vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pids.includes(Number(pid)))
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
}
const statOf = (pid: number, state: string, ppid: number, start: number) =>
  `${pid} (process) ${state} ${ppid} ${Array(17).fill(0).join(" ")} ${start}`;

it.each([
  ["a zombie at its first read", true],
  ["gone from the listing", false],
] as const)(
  "reads /proc again when a child's environ is refused, and the child dying in between is not counted (%s)",
  async (_name, zombie) => {
    const containment = new ExecutionContainment({
      bootId: "boot",
      dataDirectory: "/data",
      platform: "linux",
    });
    const engine = {
      "/proc/601/stat": statOf(601, "S", process.pid, 301),
      "/proc/601/environ": `${executionScopeVariable}=${containment.scope("run")}\0`,
    };
    // Pass 1: the engine's SSH command (602) is exiting as the pass reads it. Pass 2 sees how it ended.
    const proc = fakeProc((pass) =>
      pass === 1
        ? {
            listing: ["601", "602"],
            files: {
              ...engine,
              "/proc/602/stat": statOf(602, "S", 601, 302),
              "/proc/602/environ": "EACCES",
            },
          }
        : zombie
          ? {
              listing: ["601", "602"],
              files: {
                ...engine,
                "/proc/602/stat": statOf(602, "Z", 601, 302),
                "/proc/602/environ": "EACCES",
                "/proc/602/task": "602",
              },
            }
          : { listing: ["601"], files: engine },
    );
    const kill = onlyGone(602);
    // One tree, the engine's.
    await expect(containment.liveRoots("run")).resolves.toBe(1);
    expect(proc.passes()).toBe(2);
    kill.mockRestore();
  },
);

it("keeps a refused child unverifiable when every pass refuses it, within the bound", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  const proc = fakeProc(() => ({
    listing: ["701", "702"],
    files: {
      "/proc/701/stat": statOf(701, "S", process.pid, 401),
      "/proc/701/environ": `${executionScopeVariable}=${containment.scope("run")}\0`,
      // A live setuid child of the engine: refused on every pass.
      "/proc/702/stat": statOf(702, "S", 701, 402),
      "/proc/702/environ": "EACCES",
    },
  }));
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
  expect(proc.passes()).toBeLessThanOrEqual(3);
});

it("sees the live child a dying process forked during the pass, in the next pass", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  const run = `${executionScopeVariable}=${containment.scope("run")}\0`;
  const engine = { "/proc/801/stat": statOf(801, "S", process.pid, 501), "/proc/801/environ": run };
  // 802 forked 803 after the first listing, then exited; 803 was reparented and runs on.
  fakeProc((pass) =>
    pass === 1
      ? {
          listing: ["801", "802"],
          files: {
            ...engine,
            "/proc/802/stat": statOf(802, "S", 801, 502),
            "/proc/802/environ": "EACCES",
          },
        }
      : {
          listing: ["801", "803"],
          files: {
            ...engine,
            "/proc/803/stat": statOf(803, "S", 1, 503),
            "/proc/803/environ": run,
          },
        },
  );
  const kill = onlyGone(802);
  // Two trees: the engine and the Run's reparented child, which is still work of the Run.
  await expect(containment.liveRoots("run")).resolves.toBe(2);
  kill.mockRestore();
});

it("keeps a refused child the next listing hides (hidepid=2) unverifiable while the kernel says it lives", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  const engine = {
    "/proc/1101/stat": statOf(1101, "S", process.pid, 801),
    "/proc/1101/environ": `${executionScopeVariable}=${containment.scope("run")}\0`,
  };
  // 1102 turns non-dumpable: its environ is refused, then /proc stops listing it. It runs on.
  fakeProc((pass) =>
    pass === 1
      ? {
          listing: ["1101", "1102"],
          files: {
            ...engine,
            "/proc/1102/stat": statOf(1102, "S", 1101, 802),
            "/proc/1102/environ": "EACCES",
          },
        }
      : { listing: ["1101"], files: engine },
  );
  const kill = onlyGone();
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
  kill.mockRestore();
});

it("counts a zombie leader whose other threads still run as unreadable, never as ended", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  fakeProc(() => ({
    listing: ["901"],
    files: {
      // The Run's process ended its main thread: Z, with no environment left to read.
      "/proc/901/stat": statOf(901, "Z", process.pid, 601),
      "/proc/901/environ": "",
      "/proc/901/task": "901,902",
      "/proc/901/task/902/stat": statOf(902, "S", process.pid, 601),
    },
  }));
  await expect(containment.liveRoots("run")).resolves.toBe("unverifiable");
});

it("counts a zombie leader as ended when every task of its group has ended", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "linux",
  });
  fakeProc(() => ({
    listing: ["951"],
    files: {
      "/proc/951/stat": statOf(951, "Z", process.pid, 701),
      "/proc/951/environ": "EACCES",
      "/proc/951/task": "951,952",
      "/proc/951/task/952/stat": statOf(952, "Z", process.pid, 701),
    },
  }));
  await expect(containment.liveRoots("run")).resolves.toBe(0);
});
