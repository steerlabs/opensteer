import { expect, it } from "vitest";
import { programEnvironment } from "./program-environment.js";
it("copies the program allowlist without Runner, provider or tool credentials", () => {
  expect(
    programEnvironment(
      {
        HOME: "/home/person",
        PATH: "/bin",
        LANG: "en_US.UTF-8",
        OPENSTEER_MCP_TOKEN: "private",
        OPENAI_API_KEY: "private",
        AWS_SECRET_ACCESS_KEY: "private",
        PORT: "1234",
        SystemRoot: "C:\\Windows",
        TERM: "",
      },
      "linux",
    ),
  ).toEqual({ HOME: "/home/person", PATH: "/bin", LANG: "en_US.UTF-8" });
});

it("keeps the Windows baseline for programs on Windows", () => {
  expect(
    programEnvironment(
      {
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        NODE_OPTIONS: "--require evil.js",
        OPENSTEER_MCP_TOKEN: "private",
        Path: "C:\\Windows\\system32",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Users\\Ada\\AppData\\Local\\Temp",
      },
      "win32",
    ),
  ).toEqual({
    APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    PATH: "C:\\Windows\\system32",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Users\\Ada\\AppData\\Local\\Temp",
  });
});
