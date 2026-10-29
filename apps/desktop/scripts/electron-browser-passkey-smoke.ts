import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * Real Electron browser pages see no WebAuthn and get an immediate answer to
 * every passkey request, in a disposable, isolated userData directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { runPasskeyPolicyScenario } from "@opensteer/browser-runtime-core/test-support/passkey-policy";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";

const smokeDownloads = smokeDesktopDownloads();

const userData = mkdtempSync(path.join(tmpdir(), "opensteer-passkey-smoke-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("headless");
const liveness = setInterval(() => undefined, 1_000);
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});

void run().then(
  () => finish(null),
  (error: unknown) => finish(error),
);

async function run(): Promise<void> {
  await app.whenReady();
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDownloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const report = await runPasskeyPolicyScenario({ engine: "electron", launcher });
  const artifactDirectory =
    process.env.OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-passkey-policy-e2e");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    path.join(artifactDirectory, "electron.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

function finish(error: unknown): void {
  finished = true;
  clearInterval(liveness);
  rmSync(userData, { recursive: true, force: true });
  if (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "electron-browser-passkey-smoke.failed", error: error instanceof Error ? error.stack : String(error) })}\n`,
    );
    app.exit(1);
  } else {
    process.stdout.write(`${JSON.stringify({ event: "electron-browser-passkey-smoke.passed" })}\n`);
    app.quit();
  }
}
