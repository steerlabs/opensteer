import { describe, expect, it } from "vitest";
import { mergeEnvironment, selectEnvironment } from "./userEnvironment.js";

describe("user environment", () => {
  it("merges Windows names case-insensitively so one spelling survives and overrides win", () => {
    expect(
      mergeEnvironment(
        { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
        { PATH: "C:\\plugin\\bin", temp: "D:\\scratch" },
        "win32",
      ),
    ).toEqual({ PATH: "C:\\plugin\\bin", SystemRoot: "C:\\Windows", temp: "D:\\scratch" });
  });

  it("keeps POSIX names case-sensitive", () => {
    expect(mergeEnvironment({ Path: "/a", PATH: "/b" }, { path: "/c" }, "darwin")).toEqual({
      Path: "/a",
      PATH: "/b",
      path: "/c",
    });
  });

  it("selects the named variables plus the Windows baseline, matched case-insensitively", () => {
    const source = {
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      HOME: "C:\\Users\\Ada",
      NODE_OPTIONS: "--require evil.js",
      OPENAI_API_KEY: "secret",
      Path: "C:\\Windows\\System32",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      SYSTEMROOT: "C:\\Windows",
      windir: "C:\\Windows",
    };
    expect(selectEnvironment(source, ["HOME", "TERM"], "win32")).toEqual({
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      HOME: "C:\\Users\\Ada",
      PATH: "C:\\Windows\\System32",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
    });
    expect(selectEnvironment(source, ["HOME", "Path", "ComSpec"], "linux")).toEqual({
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      HOME: "C:\\Users\\Ada",
      Path: "C:\\Windows\\System32",
    });
  });
});
