import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  execute: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: f.execute }) };
});
vi.mock("node:fs/promises", () => ({ access: f.access, readdir: f.readdir }));
vi.mock("node:fs", () => ({ watch: f.watch }));
import { iphoneMacSupport } from "./mac-support.js";
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("finds selected, indexed and Applications Xcodes and only existing bundled image roots", async () => {
  f.execute.mockImplementation(async (command: string) => ({
    stdout: command.endsWith("xcode-select")
      ? "/Volumes/Tools/Xcode.app/Contents/Developer\n"
      : "/Applications/Xcode-Beta.app\n/Applications/Xcode.app\n",
  }));
  f.readdir.mockResolvedValue(["Xcode.app", "Xcode-Old.app", "Other.app"]);
  f.access.mockImplementation(async (file: string) => {
    if (file.endsWith("Xcode-Old.app") || file.includes("Xcode-Beta.app/Contents/"))
      throw new Error("missing");
  });
  expect(await iphoneMacSupport.inspect()).toEqual({
    xcodeApps: [
      "/Volumes/Tools/Xcode.app",
      "/Applications/Xcode-Beta.app",
      "/Applications/Xcode.app",
    ],
    imageRoots: [
      "/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore",
      "/Volumes/Tools/Xcode.app/Contents/Resources/CoreDeviceDDIs/iOS_DDI/Restore",
      "/Applications/Xcode.app/Contents/Resources/CoreDeviceDDIs/iOS_DDI/Restore",
    ],
  });
});
it("recognizes a Mac with only command line tools as missing Xcode", async () => {
  f.execute.mockImplementation(async (command: string) => {
    if (command.endsWith("mdfind")) throw new Error("index unavailable");
    return { stdout: "/Library/Developer/CommandLineTools\n" };
  });
  f.readdir.mockResolvedValue([]);
  expect((await iphoneMacSupport.inspect()).xcodeApps).toEqual([]);
});
it("watches developer image installation, falls back when directories are absent, and stops all checks", async () => {
  vi.useFakeTimers();
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  f.watch.mockImplementation((root: string) => {
    if (root === "/Library/Developer/DeveloperDiskImages") return watcher;
    throw new Error("directory missing");
  });
  const changed = vi.fn();
  const stop = iphoneMacSupport.watch(changed);
  expect(f.watch).toHaveBeenCalledWith(
    "/Library/Developer/DeveloperDiskImages",
    { recursive: true },
    changed,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(changed).toHaveBeenCalledOnce();
  stop();
  expect(watcher.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("opens the App Store or the discovered Xcode only for a help action", async () => {
  await iphoneMacSupport.help("get-xcode");
  await iphoneMacSupport.help("open-xcode", "/Applications/Xcode-Beta.app");
  expect(f.execute.mock.calls).toEqual([
    ["/usr/bin/open", ["macappstore://apps.apple.com/app/id497799835"]],
    ["/usr/bin/open", ["-a", "/Applications/Xcode-Beta.app"]],
  ]);
});
