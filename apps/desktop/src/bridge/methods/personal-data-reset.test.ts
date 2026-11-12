import { withTimeout } from "@opensteer/shared/withTimeout";
import { createId } from "@opensteer/core";
import { PersonalDataReset } from "../../supervisor/personal-data-reset.js";
import { desktopPersonalDataReset } from "../../app/personal-data-reset.js";
import type { DesktopBridgeContext } from "../context.js";
import type { IpcMainInvokeEvent } from "electron";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { handleOldPersonalData, handleStartFresh } from "./personal-data-reset.js";

it("exposes the exact temp-directory reset plan and fences simultaneous bridge resets until restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-reset-bridge-"));
  try {
    const reset = new PersonalDataReset({
      dataDirectory: root,
      cryptography: {
        isAsyncEncryptionAvailable: async () => true,
        getSelectedStorageBackend: () => "keychain",
        encryptStringAsync: async (value) => Buffer.from(value),
        decryptStringAsync: async (value) => ({ result: value.toString(), shouldReEncrypt: false }),
      },
    });
    const oldData = await reset.plan(createId("deployment"));
    const steps: string[] = [];
    let release!: () => void;
    const quiet = withTimeout(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      1_000,
      { timeoutError: () => new Error("Reset bridge never released its writer fence.") },
    );
    const startFresh = vi.fn(async () => {
      steps.push("supervisor-reset");
      await reset.execute(oldData);
      return {} as never;
    });
    const personalDataReset = desktopPersonalDataReset({
      personal: { oldData, startFresh },
      quiesce: async () => {
        steps.push("quiesce");
        await quiet;
      },
      clearSession: async (id) => {
        expect(id).toBe(oldData.deploymentId);
        steps.push("clear-session");
      },
      restart: () => {
        steps.push("restart");
      },
    });
    const mainFrame = { url: "app://opensteer/" };
    const sender = { mainFrame };
    const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    const context = {
      options: {
        bridgeToken: "fixture",
        personalDataReset,
        isWorkspaceContents: (candidate: unknown) => candidate === sender,
      },
    } as unknown as DesktopBridgeContext;
    expect(await handleOldPersonalData(context)(event, { bridgeToken: "fixture" })).toEqual(
      oldData,
    );
    const first = handleStartFresh(context)(event, { bridgeToken: "fixture" });
    const second = handleStartFresh(context)(event, { bridgeToken: "fixture" });
    expect(steps).toEqual(["quiesce"]);
    release();
    await Promise.all([first, second]);
    expect(startFresh).toHaveBeenCalledExactlyOnceWith({ restart: false });
    expect(steps).toEqual(["quiesce", "supervisor-reset", "clear-session", "restart"]);
    expect(await reset.pending()).toBeNull();
    await expect(handleStartFresh(context)(event, { bridgeToken: "wrong" })).rejects.toThrow(
      "capability",
    );
    const panelFrame = { url: "app://opensteer/settings" };
    await expect(
      handleStartFresh(context)(
        {
          sender: { mainFrame: panelFrame },
          senderFrame: panelFrame,
        } as unknown as IpcMainInvokeEvent,
        { bridgeToken: "fixture" },
      ),
    ).rejects.toThrow("application window");
    expect(startFresh).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
