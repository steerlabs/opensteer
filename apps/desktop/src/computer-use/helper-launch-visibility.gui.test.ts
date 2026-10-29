import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerUseHelperClient } from "./helper-client.js";
import type { ComputerUseHelperProcess } from "./helper-install.js";

const execFileAsync = promisify(execFile);
const fixtureSource = fileURLToPath(
  new URL(
    "../../native/computer-use/Tests/Fixtures/OverlayVisibilityFixture/OverlayVisibility.swift",
    import.meta.url,
  ),
);
/** An app; its process identifier can be -1, as Safari's is. */
const application = z
  .object({
    bundleIdentifier: z.string().nullable(),
    isSelf: z.boolean(),
    name: z.string().nullable(),
    processIdentifier: z.number().int(),
  })
  .nullable();
const visibilityReport = z.object({
  pid: z.number().int(),
  frontmostAtLaunch: application,
  frontmostAfterShow: application,
  /** Apps that came to the front while the fixture ran, in order. */
  activations: z.array(application),
  becameActive: z.boolean(),
  isActive: z.boolean(),
  isHidden: z.boolean(),
  panelIsVisible: z.boolean(),
  panelIsOnScreen: z.boolean(),
});

describe.runIf(process.platform === "darwin")("computer use helper launch visibility", () => {
  let directory = "";
  let helperAppPath = "";

  // The fixture is built before the case and outside its 45 s: a first AppKit
  // compile with only the Command Line Tools takes about a minute (GUI golden,
  // VM job 20261028T180725Z-e629539e: 57 s cold, 1 s warm, the case 5 s).
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "opensteer-overlay-launch-"));
    helperAppPath = path.join(directory, "Overlay Visibility Fixture.app");
    const executableDirectory = path.join(helperAppPath, "Contents", "MacOS");
    await mkdir(executableDirectory, { recursive: true });
    await writeFile(
      path.join(helperAppPath, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OverlayVisibility</string>
<key>CFBundleIdentifier</key><string>com.opensteer.overlay-visibility-fixture</string>
<key>CFBundleName</key><string>Overlay Visibility Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
    );
    await execFileAsync("/usr/bin/swiftc", [
      fixtureSource,
      "-o",
      path.join(executableDirectory, "OverlayVisibility"),
    ]);
  }, 180_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("shows a late-created overlay without taking the foreground app", async () => {
    const output = path.join(helperAppPath, "visibility.json");
    let launched = false;
    const run: ComputerUseHelperProcess = async (file, arguments_) => {
      if (file === "/usr/bin/codesign") {
        // The temporary fixture has its own bundle ID. Signature and peer
        // checks are unrelated to the LaunchServices visibility regression.
        return "Identifier=com.opensteer.computer-use\nSignature=adhoc\nCDHash=fixture\n";
      }
      if (file !== "/usr/bin/open") throw new Error(`Unexpected command: ${file}`);
      const { stdout, stderr } = await execFileAsync(file, [...arguments_]);
      launched = true;
      return `${stdout}${stderr}`;
    };
    const launchClient = new ComputerUseHelperClient({
      appBundleId: "com.opensteer.opensteer",
      appVersion: "1",
      helperAppPath,
      helperLockPath: path.join(directory, "lifecycle.lock"),
      launchTimeoutMs: 500,
      requestTimeoutMs: 10_000,
      run,
      socketPath: path.join(directory, "ipc.sock"),
      teamId: null,
      verifierAppPath: helperAppPath,
    });
    try {
      // The UI fixture has no IPC socket; the expected connection timeout
      // comes after the production client's real `open` invocation.
      await expect(launchClient.handshake()).rejects.toThrow(/did not start/u);
      expect(launched).toBe(true);
      const state = await waitForReport(output);
      expect(state.pid).toBeGreaterThan(0);
      // Another app is in front when the helper starts. The helper never
      // comes to the front, so the front app changes only if another app
      // came forward on its own, as when somebody switches apps meanwhile.
      expect(state.frontmostAtLaunch).toMatchObject({ isSelf: false });
      expect(state.activations.filter((app) => app?.isSelf)).toEqual([]);
      expect(state.frontmostAfterShow).toMatchObject({ isSelf: false });
      if (state.activations.length === 0) {
        expect(state.frontmostAfterShow).toEqual(state.frontmostAtLaunch);
      }
      expect(state.becameActive).toBe(false);
      expect(state.isActive).toBe(false);
      expect(state.isHidden).toBe(false);
      expect(state.panelIsVisible).toBe(true);
      expect(state.panelIsOnScreen).toBe(true);
    } finally {
      await launchClient.close();
    }
  }, 45_000);
});

async function waitForReport(output: string): Promise<z.infer<typeof visibilityReport>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const raw = await readFile(output, "utf8").catch(() => null);
    if (raw !== null) return visibilityReport.parse(JSON.parse(raw));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("The overlay fixture did not report its WindowServer visibility.");
}
