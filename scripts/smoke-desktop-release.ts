import { execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { z } from "zod";
import { descendantPids } from "./smoke-desktop-release-processes.js";

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    "artifacts-dir": { type: "string" },
  },
});
if (!values.executable) throw Error("--executable must name the packaged executable");
const started = performance.now();
const artifacts = path.resolve(
  values["artifacts-dir"] ?? path.join(tmpdir(), "desktop-launch-artifacts"),
);
await mkdir(artifacts, { recursive: true });
// Playwright can reject additional launch-output promises when an executable
// exits before opening its debugging ports. Preserve those diagnostics too.
let asynchronousError: unknown;
const asyncFailure = (error: unknown) => {
  asynchronousError = error;
  process.exitCode = 1;
  appendFileSync(path.join(artifacts, "failure.txt"), `${String(error)}\n`);
};
process.on("unhandledRejection", asyncFailure);
const home = await realpath(
  await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "opensteer-launch-")),
);
const data = path.join(home, "userdata");
const temporary = path.join(home, "tmp");
await mkdir(temporary, { mode: 0o700 });
let app: ElectronApplication | undefined;
let page: Page | undefined;
let launched: ChildProcess | undefined;
let step = "packaged executable did not launch";
let children: number[] = [];
const processTable = () =>
  execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(step)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const deadline = setTimeout(() => {
  writeFileSync(
    path.join(artifacts, "failure.txt"),
    `Launch check exceeded 180 seconds: ${step}\n`,
  );
  console.error(`Launch check exceeded 180 seconds: ${step}`);
  if (launched?.pid) children.push(...descendantPids(processTable(), launched.pid));
  for (const pid of [...children.reverse(), launched?.pid]) {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
  process.exit(1);
}, 180_000);
try {
  // Pass no signing or account credentials into the packaged process.
  app = await _electron.launch({
    executablePath: path.resolve(values.executable),
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      OPENSTEER_DESKTOP_RELEASE_SMOKE: "1",
      TMPDIR: temporary,
      OPENSTEER_DESKTOP_DATA_DIR: data,
    },
  });
  launched = app.process();
  launched.stdout?.on("data", (chunk: Buffer) =>
    appendFileSync(path.join(artifacts, "stdout.log"), chunk),
  );
  launched.stderr?.on("data", (chunk: Buffer) =>
    appendFileSync(path.join(artifacts, "stderr.log"), chunk),
  );
  step = "isolated profile was not applied";
  const actualData = await bounded(
    app.evaluate(({ app }) => app.getPath("userData")),
    5_000,
  );
  if (actualData !== data) throw Error("Packaged app ignored isolated userData");
  step = "desktop window never opened";
  page = await app.firstWindow({ timeout: 30_000 });
  const mainWindow = await bounded(app.browserWindow(page), 5_000);
  await bounded(
    mainWindow.evaluate(
      (window) =>
        window.isVisible() ||
        new Promise<boolean>((resolve) => window.once("show", () => resolve(true))),
    ),
    5_000,
  );
  const fatal: string[] = [];
  page.on("pageerror", (error) => fatal.push(error.message));
  step = "first screen never rendered";
  await page
    .getByRole("button", { name: /start|set up|use this computer/i })
    .first()
    .waitFor({ timeout: 30_000 });
  step = "Personal Host never became ready";
  await bounded(
    page.evaluate(async () => {
      const bridge = (
        window as Window & {
          opensteerDesktop?: import("../packages/protocol/src/desktop.js").OpensteerDesktopBridge;
        }
      ).opensteerDesktop!;
      // The existing operation resolves after the supervisor finishes startup.
      await bridge.createPersonalDeployment();
      const snapshot = await bridge.getDeploymentAccessSnapshot();
      if (snapshot.personalSetup?.state !== "ready")
        throw Error(
          `Personal setup is ${snapshot.personalSetup?.state}: ${snapshot.personalSetup?.issue?.detail ?? "not ready"}`,
        );
    }),
    80_000,
  );
  children = descendantPids(processTable(), launched!.pid!);
  step = "Personal Host health endpoint did not respond";
  const manifest = z
    .object({ hostPort: z.number().int().min(1).max(65535) })
    .parse(JSON.parse(await readFile(path.join(data, "personal-deployment.v1.json"), "utf8")));
  const health = await fetch(`http://127.0.0.1:${manifest.hostPort}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok) throw Error(`Host health HTTP ${health.status}`);
  step = "Personal first screen never rendered";
  await page.getByPlaceholder("Ask Opensteer…").waitFor({ timeout: 15_000 });
  if (fatal.length) throw Error(`Renderer fatal errors: ${fatal.join("; ")}`);
  step = "desktop did not quit cleanly";
  children = [...new Set([...children, ...descendantPids(processTable(), launched!.pid!)])];
  const child = launched!;
  await bounded(app.close(), 15_000);
  if (child.exitCode !== 0) throw Error(`Desktop exited ${child.exitCode}`);
  step = "desktop children survived quit";
  const survivors = children.filter(alive);
  if (survivors.length) throw Error(`Child PIDs still running: ${survivors.join(", ")}`);
  if (asynchronousError !== undefined)
    throw Error(`Asynchronous launch failure: ${String(asynchronousError)}`);
  console.log(
    `Desktop launch check passed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
} catch (error) {
  console.error(`${step}: ${String(error)}`);
  await writeFile(path.join(artifacts, "failure.txt"), `${step}: ${String(error)}\n`);
  await page
    ?.screenshot({ path: path.join(artifacts, "window.png"), timeout: 5_000 })
    .catch(() => {});
  await cp(path.join(data, "logs"), path.join(artifacts, "logs"), { recursive: true }).catch(
    () => {},
  );
  for (const deployment of await readdir(path.join(data, "deployments")).catch(() => [])) {
    await cp(
      path.join(data, "deployments", deployment, "logs"),
      path.join(artifacts, "deployments", deployment),
      { recursive: true },
    ).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (launched?.pid) children.push(...descendantPids(processTable(), launched!.pid!));
  for (const pid of [...children.reverse(), launched?.pid]) {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
  clearTimeout(deadline);
  process.off("unhandledRejection", asyncFailure);
  await rm(home, { recursive: true, force: true });
}
