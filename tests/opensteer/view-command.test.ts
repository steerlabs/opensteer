import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { parseCommandLine } from "../../packages/opensteer/src/cli/parse.js";
import { handleViewCommand } from "../../packages/opensteer/src/cli/view.js";
import {
  resolveLocalViewMode,
  setLocalViewMode,
} from "../../packages/opensteer/src/local-view/preferences.js";
import { stopLocalViewService } from "../../packages/opensteer/src/local-view/service.js";
import { readLocalViewServiceState } from "../../packages/opensteer/src/local-view/service-state.js";

describe("view command", () => {
  test("updates the local-view preference without starting the service", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-pref-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      const manualOutput = await captureStdout(async () => {
        await handleViewCommand(parseCommandLine(["view", "--no-auto"]));
      });
      expect(manualOutput).toContain("manual");
      expect(await resolveLocalViewMode()).toBe("manual");
      expect(await readLocalViewServiceState()).toBeUndefined();

      const autoOutput = await captureStdout(async () => {
        await handleViewCommand(parseCommandLine(["view", "--auto"]));
      });
      expect(autoOutput).toContain("auto");
      expect(await resolveLocalViewMode()).toBe("auto");
      expect(await readLocalViewServiceState()).toBeUndefined();
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("starts and stops the service without changing a manual preference", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-stop-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      await setLocalViewMode("manual");

      const started = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "--json"]));
        }),
      ) as { readonly url: string };

      expect(started.url).toContain("127.0.0.1");
      expect(await resolveLocalViewMode()).toBe("manual");

      const runningState = await waitFor(async () => {
        const current = await readLocalViewServiceState();
        if (!current) {
          return null;
        }
        const health = await fetch(new URL("/api/health", current.url), {
          headers: {
            "x-opensteer-local-token": current.token,
          },
        }).catch(() => null);
        return health?.ok === true ? current : null;
      });
      expect(runningState.url).toBe(started.url);

      const stopped = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "stop", "--json"]));
        }),
      ) as { readonly stopped: boolean };
      expect(stopped).toEqual({ stopped: true });
      expect(await resolveLocalViewMode()).toBe("manual");
      await waitFor(async () => ((await readLocalViewServiceState()) === undefined ? true : null));
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("reports stop=false when the service is already stopped", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-idle-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      await setLocalViewMode("auto");
      const output = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "stop", "--json"]));
        }),
      ) as { readonly stopped: boolean };
      expect(output).toEqual({ stopped: false });
      expect(await resolveLocalViewMode()).toBe("auto");
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });
});

async function captureStdout(task: () => Promise<void>): Promise<string> {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await task();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function waitFor<T>(task: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await task();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}
