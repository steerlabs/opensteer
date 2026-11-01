import { app } from "electron";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";
import { profileFailureDiagnostic } from "../src/browser/profile-failure-diagnostic.js";
import { cert, key } from "./fixtures/profile-restore-tls.js";
import {
  nativeProfileSmokePhases,
  nativeSmokeWorker,
  runNativeProfileSmokePhase,
} from "./test-support/native-profile-smoke.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
const phase = process.env.PROFILE_VM_PHASE ?? "native-create";
const state = realpathSync(
  process.env.PROFILE_VM_STATE ?? mkdtempSync(path.join(tmpdir(), "native-profile-")),
);
const out =
  process.env.PROFILE_VM_OUT ??
  process.env.OPENSTEER_PROFILE_RESTORE_ARTIFACT_DIR ??
  path.join(tmpdir(), "native-profile-proof");
mkdirSync(out, { recursive: true });
type Result = {
  status: "pass" | "fail";
  observed: Record<string, unknown>;
  error?: string;
  diagnostic?: unknown;
};
const results: Record<string, Result> = {};
const first = new Map<string, string>();
const port = 18766;
const origin = (index: number) => `https://s${index}.example.test:${port}`;
const server = createServer({ key, cert }, (request, response) => {
  const url = new URL(request.url ?? "/", `https://${request.headers.host}`);
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/native-page")
    first.set(url.searchParams.get("phase") ?? "", request.headers.cookie ?? "");
  if (url.pathname === "/native-sw.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(nativeSmokeWorker);
  } else if (url.pathname === "/native-logout") {
    response.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None");
    response.end("signed out");
  } else if (url.pathname === "/native-clear-site-data") {
    response.setHeader("Clear-Site-Data", '"cookies", "storage", "cache"');
    response.end("cleared");
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Native profile</title>");
  }
});
function persist() {
  writeFileSync(
    path.join(out, `results-${phase}.json`),
    JSON.stringify({ phase, results }, null, 2),
  );
}
async function main() {
  const userData = path.join(state, "native-user-data");
  mkdirSync(path.join(userData, "session"), { recursive: true });
  configureDesktopApplicationPaths(app, userData);
  app.commandLine.appendSwitch("headless");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.example.test 127.0.0.1");
  app.commandLine.appendSwitch("no-proxy-server");
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.on("window-all-closed", () => {});
  let launcher: ElectronBrowserLauncher | undefined;
  let failed = false;
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    launcher = new ElectronBrowserLauncher({
      downloads: smokeDesktopDownloads(),
      localProfileRoot: path.join(userData, "session", "browser-profiles"),
      pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
    });
    const observed = await runNativeProfileSmokePhase({
      phase,
      state,
      launcher,
      origin,
      firstRequest: (name) => first.get(name),
    });
    results[phase] = { status: "pass", observed: { ...observed } };
    persist();
    if (observed.crash) process.kill(process.pid, "SIGKILL");
  } catch (error) {
    failed = true;
    results[phase] = {
      status: "fail",
      observed: {},
      error: String(error),
      diagnostic: profileFailureDiagnostic(error),
    };
  } finally {
    launcher?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    persist();
    app.exit(failed ? 1 : 0);
  }
}
async function driver() {
  // Inside Electron, require("electron") is the API object, not a path.
  const executable = process.execPath;
  let failed = false;
  try {
    for (const name of nativeProfileSmokePhases) {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(executable, [import.meta.filename], {
          stdio: "inherit",
          env: {
            ...process.env,
            PROFILE_VM_PHASE: name,
            PROFILE_VM_STATE: state,
            PROFILE_VM_OUT: out,
          },
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          const crash = name === "native-crash";
          const evidence = path.join(out, `results-${name}.json`);
          const passed =
            existsSync(evidence) &&
            Object.values(
              (JSON.parse(readFileSync(evidence, "utf8")) as { results: Record<string, Result> })
                .results,
            ).every((result) => result.status === "pass");
          resolve(crash ? (signal === "SIGKILL" && passed ? 0 : 1) : (code ?? 1));
        });
      });
      failed ||= code !== 0;
    }
    const summary = path.join(out, "results.json");
    if (existsSync(summary)) {
      const result = JSON.parse(readFileSync(summary, "utf8")) as { nativePhases?: unknown[] };
      result.nativePhases = nativeProfileSmokePhases.map(
        (name) =>
          JSON.parse(readFileSync(path.join(out, `results-${name}.json`), "utf8")) as unknown,
      );
      writeFileSync(summary, JSON.stringify(result, null, 2));
    }
  } catch (error) {
    failed = true;
    process.stderr.write(`profile restore driver failed: ${String(error)}\n`);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
  app.exit(failed ? 1 : 0);
}
if (process.env.PROFILE_VM_PHASE) void main();
else {
  const driverData = path.join(state, "driver-user-data");
  mkdirSync(driverData, { recursive: true });
  app.setPath("userData", driverData);
  app.commandLine.appendSwitch("headless");
  void driver();
}
