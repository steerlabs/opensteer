import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertDesktopLaunch } from "./launch-policy.js";

const executable = "/Applications/Opensteer.app/Contents/MacOS/Opensteer";
const callbackScheme = "opensteer";

function launch(
  argumentsAfterExecutable: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  packaged = true,
): void {
  assertDesktopLaunch({
    argv: [executable, ...argumentsAfterExecutable],
    callbackScheme,
    environment,
    packaged,
  });
}

// Ways a hostile same-user process could start a signed Opensteer that leaks
// its pages, its TLS or its sandbox, each of which the policy must refuse.
describe("Desktop launch policy", () => {
  it.each([
    ["--remote-debugging-port=9222"],
    ["--remote-debugging-pipe"],
    ["--remote-debugging-address=0.0.0.0"],
    ["--remote-allow-origins=*"],
    ["--inspect=9229"],
    ["--inspect-brk"],
    ["--proxy-server=http://127.0.0.1:8080"],
    ["--proxy-pac-url=http://127.0.0.1/proxy.pac"],
    ["--ignore-certificate-errors"],
    ["--ignore-certificate-errors-spki-list=abc"],
    ["--host-resolver-rules=MAP * 127.0.0.1"],
    ["--ssl-key-log-file=/tmp/keys"],
    ["--load-extension=/tmp/extension"],
    ["--disable-web-security"],
    ["--js-flags=--allow-natives-syntax"],
    ["--user-data-dir=/tmp/other"],
    ["--enable-logging"],
    ["-psn_0_12345"],
    ["--opensteer-start-hidden=1"],
    ["https://attacker.example/"],
    ["/tmp/other-app-entry.js"],
  ])("refuses a packaged launch with %s", (argument) => {
    expect(() => launch([argument])).toThrow(/doesn’t accept/u);
  });

  it("refuses the sandbox switch with its own explanation", () => {
    expect(() => launch(["--no-sandbox"])).toThrow(/Chromium sandbox/u);
  });

  it("refuses a packaged launch that asks Chromium to log TLS keys", () => {
    expect(() => launch([], { SSLKEYLOGFILE: "/tmp/keys" })).toThrow(/SSLKEYLOGFILE/u);
  });

  it("refuses an allowed argument once a forbidden one follows it", () => {
    expect(() => launch(["--opensteer-start-hidden", "--remote-debugging-port=0"])).toThrow(
      /remote-debugging-port/u,
    );
  });

  it("accepts how macOS, its login item and its callback links start a package", () => {
    expect(() => launch([])).not.toThrow();
    expect(() => launch(["--opensteer-start-hidden"])).not.toThrow();
    expect(() => launch(["opensteer://oauth/callback?code=abc&state=def"])).not.toThrow();
    expect(() =>
      launch(["--opensteer-start-hidden", "opensteer://oauth/callback?code=abc"]),
    ).not.toThrow();
  });

  it("leaves development launches to the developer", () => {
    expect(() =>
      launch(["--remote-debugging-port=9222", "--no-sandbox"], { SSLKEYLOGFILE: "/tmp/k" }, false),
    ).not.toThrow();
  });
});

it("admits only ephemeral Playwright ports in a fresh private smoke profile", () => {
  const home = mkdtempSync(path.join(tmpdir(), "opensteer-launch-"));
  const environment = {
    OPENSTEER_DESKTOP_RELEASE_SMOKE: "1",
    HOME: home,
    OPENSTEER_DESKTOP_DATA_DIR: path.join(home, "userdata"),
    OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT: path.join(home, "workspace"),
  };
  try {
    expect(() => launch(["--inspect=0", "--remote-debugging-port=0"], environment)).not.toThrow();
    for (const flag of [
      "--inspect=9229",
      "--remote-debugging-port=9222",
      "--remote-debugging-address=0.0.0.0",
      "--no-sandbox",
    ])
      expect(() => launch([flag], environment)).toThrow();
    expect(() =>
      launch(["--inspect=0"], { ...environment, OPENSTEER_DESKTOP_DATA_DIR: "/tmp/other" }),
    ).toThrow(/isolated/);
    expect(() =>
      launch(["--inspect=0"], { ...environment, OPENSTEER_DESKTOP_RELEASE_SMOKE: undefined }),
    ).toThrow();
    mkdirSync(environment.OPENSTEER_DESKTOP_DATA_DIR);
    expect(() => launch(["--inspect=0"], environment)).toThrow(/fresh/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
