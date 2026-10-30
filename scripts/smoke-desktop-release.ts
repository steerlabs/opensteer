import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
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
const home = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "opensteer-launch-"));
const data = path.join(home, "userdata");
let app: ElectronApplication | undefined;
let page: Page | undefined;
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
const deadline = setTimeout(() => {
  console.error(`Launch check exceeded 180 seconds: ${step}`);
  for (const pid of [...children, app?.process().pid].reverse()) {
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
      TMPDIR: home,
      OPENSTEER_DESKTOP_DATA_DIR: data,
      OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT: path.join(home, "workspace"),
    },
  });
  app
    .process()
    .stdout?.on(
      "data",
      (chunk: Buffer) => void writeFile(path.join(artifacts, "stdout.log"), chunk, { flag: "a" }),
    );
  app
    .process()
    .stderr?.on(
      "data",
      (chunk: Buffer) => void writeFile(path.join(artifacts, "stderr.log"), chunk, { flag: "a" }),
    );
  // Decline the first-run move prompt without touching the installed application.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  step = "desktop window never opened";
  page = await app.firstWindow({ timeout: 30_000 });
  const fatal: string[] = [];
  page.on("pageerror", (error) => fatal.push(error.message));
  step = "first screen never rendered";
  await page
    .getByRole("button", { name: /start|set up|use this computer/i })
    .first()
    .waitFor({ timeout: 30_000 });
  step = "Personal Host never became ready";
  // This is the same action as the welcome screen's setup button.
  await page.evaluate(() => {
    void (
      window as Window & {
        opensteerDesktop: import("@opensteer/protocol/desktop").OpensteerDesktopBridge;
      }
    ).opensteerDesktop.createPersonalDeployment();
  });
  await page.waitForFunction(
    async () => {
      const snapshot = await (
        window as Window & {
          opensteerDesktop: import("@opensteer/protocol/desktop").OpensteerDesktopBridge;
        }
      ).opensteerDesktop.getDeploymentAccessSnapshot();
      if (snapshot.personalSetup?.state === "failed") throw Error("Personal setup failed");
      return snapshot.personalSetup?.state === "ready";
    },
    undefined,
    { timeout: 80_000 },
  );
  children = descendantPids(processTable(), app.process().pid!);
  const deployments = await readdir(path.join(data, "deployments"));
  const manifest = JSON.parse(
    await readFile(path.join(data, "deployments", deployments[0]!, "deployment.v1.json"), "utf8"),
  ) as { hostPort: number };
  step = "Personal Host health endpoint did not respond";
  const health = await fetch(`http://127.0.0.1:${manifest.hostPort}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok) throw Error(`Host health HTTP ${health.status}`);
  step = "Personal first screen never rendered";
  await page.getByPlaceholder("Ask Opensteer…").waitFor({ timeout: 15_000 });
  if (fatal.length) throw Error(`Renderer fatal errors: ${fatal.join("; ")}`);
  step = "desktop did not quit cleanly";
  children = [...new Set([...children, ...descendantPids(processTable(), app.process().pid!)])];
  const child = app.process();
  await Promise.race([
    app.close(),
    new Promise<never>((_, reject) => setTimeout(() => reject(Error(step)), 15_000).unref()),
  ]);
  if (child.exitCode !== 0) throw Error(`Desktop exited ${child.exitCode}`);
  step = "desktop children survived quit";
  const survivors = children.filter(alive);
  if (survivors.length) throw Error(`Child PIDs still running: ${survivors.join(", ")}`);
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
  process.exitCode = 1;
} finally {
  if (app?.process().pid) children.push(...descendantPids(processTable(), app.process().pid!));
  for (const pid of [...children.reverse(), app?.process().pid]) {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }
  clearTimeout(deadline);
}
