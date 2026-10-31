import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import { delay } from "@opensteer/shared/delay";
import {
  TestChromiumLauncher,
  findChromium,
  browserTestSignal,
  waitForBrowserState,
} from "./browser-test-lifecycle.js";

const executablePath = findChromium();
let pid: number | undefined;
let checks = 0;
let stoppedChecks = 0;

describe("Chromium journey timeout cancellation", () => {
  describe("an already-started journey", () => {
    beforeEach(async () => {
      const browser = await new TestChromiumLauncher({
        chromiumSandbox: false,
        executablePath,
        headless: true,
      }).launch({
        initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
        partitionKey: `session:${validClaims().sessionId}`,
        sessionId: validClaims().sessionId,
        storage: { kind: "guest" },
      });
      const inventory = (await browser.cdp.send("SystemInfo.getProcessInfo")) as {
        processInfo: Array<{ id: number; type: string }>;
      };
      pid = inventory.processInfo.find((entry) => entry.type === "browser")!.id;
    });

    it.fails("cancels a real journey through its own test signal", { timeout: 5_000 }, async () => {
      await waitForBrowserState(() => {
        checks += 1;
        return false;
      });
    });
  });

  it("leaves no live browser or polling work in the next journey", async () => {
    expect(pid).toBeDefined();
    expect(checks).toBeGreaterThan(0);
    stoppedChecks = checks;
    await delay(150, browserTestSignal());
    expect(checks).toBe(stoppedChecks);
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});

afterAll(async () => {
  const directory =
    process.env.OPENSTEER_CHROMIUM_TEARDOWN_E2E_ARTIFACT_DIR ??
    join(tmpdir(), "opensteer-chromium-teardown-e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `cancellation-${process.pid}.json`),
    `${JSON.stringify({ pid, checks, stoppedChecks, cancelledByTestSignal: true }, null, 2)}\n`,
  );
});
