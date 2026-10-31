import type { Adb } from "@yume-chan/adb";
import { ReadableStream } from "@yume-chan/stream-extra";
import { expect, it, vi } from "vitest";
import { agentPhoneAdb } from "./tango-adb.js";

function stream(bytes: Uint8Array[], cancel = vi.fn(), end = true) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk);
      if (end) controller.close();
    },
    cancel,
  });
}
function fakeAdb() {
  const kill = vi.fn();
  const process = { stdout: stream([]), stderr: stream([]), exited: Promise.resolve(0), kill };
  const spawn = vi.fn(async () => process);
  const sync = {
    stat: vi.fn(async () => ({ size: 1n })),
    read: vi.fn(() => stream([new Uint8Array([1])])),
    dispose: vi.fn(),
  };
  const adb = {
    canUseFeature: () => false,
    subprocess: {
      shellProtocol: { isSupported: true, spawn },
      noneProtocol: {
        spawn: vi.fn(async () => ({ output: stream([new TextEncoder().encode("11\n")]), kill })),
      },
    },
    sync: vi.fn(async () => sync),
  } as unknown as Adb;
  return { port: agentPhoneAdb(adb), process, spawn, sync, kill };
}
it("bounds actual file bytes even when a file grows after stat", async () => {
  const h = fakeAdb();
  const cancel = vi.fn();
  h.sync.read.mockReturnValue(stream([new Uint8Array(5)], cancel, false));
  await expect(h.port.readFile("/data/app/base.apk", 4)).rejects.toThrow("size limit");
  expect(h.sync.dispose).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { timeout: 1_000 });
});
it("stops a shell that exceeds the output limit before buffering the whole response", async () => {
  const h = fakeAdb();
  const cancel = vi.fn();
  h.process.stdout = stream([new Uint8Array(1_024 * 1_024), new Uint8Array(1)], cancel, false);
  await expect(h.port.shell(["dumpsys", "lock_settings"])).rejects.toThrow("size limit");
  expect(h.kill).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { timeout: 1_000 });
});
it("preserves shell arguments and supports the legacy property check", async () => {
  const h = fakeAdb();
  expect(await h.port.getProp("ro.build.version.release")).toBe("11");
  await expect(h.port.shell(["printf", "$value and spaces"])).resolves.toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(h.spawn).toHaveBeenCalledWith(["'printf'", "'$value and spaces'"]);
});
