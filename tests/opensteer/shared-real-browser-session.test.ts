import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const processOwnerState = vi.hoisted(() => {
  const currentOwner = {
    pid: 1001,
    processStartedAtMs: 10_001,
  };

  return {
    CURRENT_PROCESS_OWNER: currentOwner,
    getProcessLiveness: vi.fn(async () => "live" as const),
    parseProcessOwner: (value: unknown) => {
      if (!value || typeof value !== "object") {
        return null;
      }
      const record = value as {
        readonly pid?: unknown;
        readonly processStartedAtMs?: unknown;
      };
      if (
        typeof record.pid !== "number"
        || !Number.isInteger(record.pid)
        || record.pid <= 0
        || typeof record.processStartedAtMs !== "number"
        || !Number.isInteger(record.processStartedAtMs)
        || record.processStartedAtMs <= 0
      ) {
        return null;
      }
      return {
        pid: record.pid,
        processStartedAtMs: record.processStartedAtMs,
      };
    },
    processOwnersEqual: (
      left:
        | {
            readonly pid: number;
            readonly processStartedAtMs: number;
          }
        | null,
      right:
        | {
            readonly pid: number;
            readonly processStartedAtMs: number;
          }
        | null,
    ) => left?.pid === right?.pid && left?.processStartedAtMs === right?.processStartedAtMs,
  };
});

vi.mock("../../packages/opensteer/src/local-browser/process-owner.js", () => ({
  CURRENT_PROCESS_OWNER: processOwnerState.CURRENT_PROCESS_OWNER,
  getProcessLiveness: processOwnerState.getProcessLiveness,
  parseProcessOwner: processOwnerState.parseProcessOwner,
  processOwnersEqual: processOwnerState.processOwnersEqual,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("local browser sessions", () => {
  test("connectCdpBrowserSession opens a fresh tab and leaves external Chrome running", async () => {
    const existingPage = {
      bringToFront: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const attachedPage = {
      bringToFront: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const context = {
      pages: vi.fn(() => [existingPage]),
      newPage: vi.fn(async () => attachedPage),
    };
    const browser = {
      close: vi.fn(async () => undefined),
      contexts: vi.fn(() => [context]),
      newBrowserCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
      })),
    };

    const { connectCdpBrowserSession } = await import(
      "../../packages/opensteer/src/local-browser/shared-session.js"
    );

    const lease = await connectCdpBrowserSession({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      freshTab: true,
      timeoutMs: 1_000,
      connectBrowser: vi.fn(async () => browser),
    });

    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(existingPage.bringToFront).not.toHaveBeenCalled();
    expect(attachedPage.bringToFront).toHaveBeenCalledTimes(1);

    await lease.close();

    expect(browser.newBrowserCDPSession).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test("launchProfileBrowserSession rejects profiles already owned by another live launcher", async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-in-use-"));
    const launchDir = path.join(
      homedir(),
      ".opensteer",
      "local-browser",
      "launches",
      createHash("sha256").update(path.resolve(userDataDir)).digest("hex").slice(0, 16),
    );
    const metadataPath = path.join(launchDir, "launch.json");

    await mkdir(launchDir, { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify({
        args: [],
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: false,
        owner: {
          pid: 2222,
          processStartedAtMs: 22_222,
        },
        userDataDir,
      }),
    );

    try {
      const { launchProfileBrowserSession } = await import(
        "../../packages/opensteer/src/local-browser/shared-session.js"
      );

      await expect(
        launchProfileBrowserSession({
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          headless: false,
          args: [],
          timeoutMs: 1_000,
          userDataDir,
          connectBrowser: vi.fn(),
        }),
      ).rejects.toThrow(
        "The selected Chrome user-data-dir appears to be in use. Attach with --auto-connect or --cdp instead of launching it again.",
      );
    } finally {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(launchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
