import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisedProcess } from "@opensteer/harness";
import { runPiCommand } from "./process.js";

const fixture = vi.hoisted(() => ({
  errorCode: undefined as string | undefined,
  received: "",
  terminated: 0,
  stillRunning: false,
}));

vi.mock("@opensteer/harness", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opensteer/harness")>();
  return {
    ...original,
    spawnSupervised: (): SupervisedProcess => {
      const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          fixture.received += chunk.toString();
          callback();
        },
        final(callback) {
          process.nextTick(() =>
            callback(
              fixture.errorCode
                ? Object.assign(new Error("stdin closed"), { code: fixture.errorCode })
                : undefined,
            ),
          );
        },
      });
      return {
        child: { stdin } as unknown as SupervisedProcess["child"],
        stdout: (async function* () {
          yield Buffer.from('{"status":"ready"}');
        })(),
        stderr: (async function* () {
          yield Buffer.from("auth diagnostic");
        })(),
        exited: fixture.stillRunning
          ? new Promise(() => undefined)
          : Promise.resolve({ code: 7, signal: null }),
        terminate: async () => {
          fixture.terminated += 1;
        },
      };
    },
  };
});

beforeEach(() => {
  fixture.errorCode = undefined;
  fixture.received = "";
  fixture.terminated = 0;
  fixture.stillRunning = false;
});

const options = {
  args: ["auth", "check"],
  cwd: process.cwd(),
  environment: {},
  launch: { executable: "pi.js", nodeExecutable: process.execPath },
  signal: new AbortController().signal,
  timeoutMs: 1_000,
};

describe("one-shot Pi stdin completion", () => {
  it("retains auth output and exit status when an empty stdin closes after early child exit", async () => {
    fixture.errorCode = "EPIPE";
    await expect(runPiCommand(options)).resolves.toEqual({
      code: 7,
      stderr: "auth diagnostic",
      stdout: '{"status":"ready"}',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.terminated).toBe(1);
  });

  it("reports a broken pipe when command input was required", async () => {
    fixture.errorCode = "EPIPE";
    await expect(runPiCommand({ ...options, stdin: "command\n" })).rejects.toMatchObject({
      code: "harness_error",
      cause: expect.objectContaining({ code: "EPIPE" }),
    });
    expect(fixture.terminated).toBe(1);
  });

  it("reports unexpected stdin errors even without input", async () => {
    fixture.errorCode = "EIO";
    await expect(runPiCommand(options)).rejects.toMatchObject({
      code: "harness_error",
      cause: expect.objectContaining({ code: "EIO" }),
    });
    expect(fixture.terminated).toBe(1);
  });

  it("writes and closes a healthy command before returning its output", async () => {
    await expect(runPiCommand({ ...options, stdin: "command\n" })).resolves.toMatchObject({
      code: 7,
    });
    expect(fixture.received).toBe("command\n");
    expect(fixture.terminated).toBe(1);
  });

  it("terminates a child that is still running when stdin fails", async () => {
    fixture.stillRunning = true;
    fixture.errorCode = "EIO";
    await expect(runPiCommand(options)).rejects.toMatchObject({
      code: "harness_error",
      cause: expect.objectContaining({ code: "EIO" }),
    });
    expect(fixture.terminated).toBe(1);
  });
});
