import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionContainment, executionScopeVariable } from "./execution-containment.js";

const mockPsState = vi.hoisted(() => ({
  handler: undefined as
    ((callIndex: number) => { readonly stdout: string; readonly stderr?: string }) | undefined,
  callIndex: 0,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: nodePromisify } = await import("node:util");
  const mockedExecFile = Object.assign(vi.fn(actual.execFile), {
    [nodePromisify.custom]: async () => {
      mockPsState.callIndex += 1;
      const result = mockPsState.handler?.(mockPsState.callIndex) ?? { stdout: "", stderr: "" };
      return { stdout: result.stdout, stderr: result.stderr ?? "" };
    },
  });
  return {
    ...actual,
    execFile: mockedExecFile,
  };
});

afterEach(() => {
  mockPsState.handler = undefined;
  mockPsState.callIndex = 0;
});

function mockPs(
  handler: (callIndex: number) => { readonly stdout: string; readonly stderr?: string },
): void {
  void execFile;
  mockPsState.callIndex = 0;
  mockPsState.handler = handler;
}

it("X1 (macOS): retries when exiting members are briefly unobserved across the first three ps passes and proves gone on the quiet fourth pass", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "darwin",
    terminationGraceMs: 100,
  });
  const scope = containment.scope("run");
  let phase: "note" | "terminate" = "note";
  let terminatePass = 0;
  mockPs(() => {
    if (phase === "note") {
      return {
        stdout: [
          `401 1 401 Mon Nov 24 02:00:00 2026 /bin/sh ${executionScopeVariable}=${scope}`,
          `402 401 401 Mon Nov 24 02:00:01 2026 /bin/sh ${executionScopeVariable}=${scope}`,
          `403 401 401 Mon Nov 24 02:00:02 2026 /bin/sh ${executionScopeVariable}=${scope}`,
        ].join("\n"),
      };
    }
    terminatePass += 1;
    // All three members exited from ps's snapshot between note() and terminate(),
    // while kill(pid, 0) briefly still observes one exiting PID on each of passes 1..3
    // before pass 4 is completely quiet.
    return { stdout: "" };
  });
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (sig === 0) {
      // Each member still answers kill(pid, 0) until its own exit pass completes:
      // pass 1 sees 401/402/403 exiting, pass 2 sees 402/403, pass 3 sees 403, pass 4 is quiet.
      if (pid === 401 && terminatePass < 2) return true;
      if (pid === 402 && terminatePass < 3) return true;
      if (pid === 403 && terminatePass < 4) return true;
      if (pid === 401 || pid === 402 || pid === 403) {
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      }
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

it("X1 (macOS): retries when ps reports a transient incomplete snapshot on the first three passes and proves gone on the fourth", async () => {
  const containment = new ExecutionContainment({
    bootId: "boot",
    dataDirectory: "/data",
    platform: "darwin",
    terminationGraceMs: 100,
  });
  const scope = containment.scope("run");
  let phase: "note" | "terminate" = "note";
  let terminatePass = 0;
  mockPs(() => {
    if (phase === "note") {
      return {
        stdout: `411 1 411 Mon Nov 24 02:00:00 2026 /bin/sh ${executionScopeVariable}=${scope}`,
      };
    }
    terminatePass += 1;
    if (terminatePass <= 3) {
      return { stdout: "", stderr: "ps: transient proc table warning\n" };
    }
    return { stdout: "" };
  });
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (sig === 0 && pid === 411) {
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
