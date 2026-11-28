import { describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { MockCloudComputerAccount, mockCloudComputerId } from "@opensteer/client/mock";
import type { DesktopBridgeContext } from "../context.js";
import { handleCloudComputerAct, handleCloudComputerRead } from "./cloud-computers.js";

function setup(options: { readonly workspace: boolean; readonly account: boolean }) {
  const frame = { url: "app://opensteer/workspaces" };
  const sender = { mainFrame: frame };
  const account = new MockCloudComputerAccount("ready");
  const read = vi.spyOn(account, "read");
  const act = vi.spyOn(account, "act");
  const context = {
    options: {
      bridgeToken: "capability",
      isWorkspaceContents: () => options.workspace,
      cloudComputers: options.account ? account : null,
    },
  } as unknown as DesktopBridgeContext;
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { context, event, read, act };
}

describe("Cloud Computers over the desktop bridge", () => {
  it("reads and acts with main's Account client for the application window only", async () => {
    const { context, event, read, act } = setup({ workspace: true, account: true });
    const result = await handleCloudComputerRead(context)(event, {
      bridgeToken: "capability",
      input: undefined,
    });
    expect(result).toMatchObject({ ok: true, data: { plan: { amountMinor: 2000 } } });
    expect(read).toHaveBeenCalledOnce();
    await handleCloudComputerAct(context)(event, {
      bridgeToken: "capability",
      input: { action: "suspend", id: mockCloudComputerId },
    });
    expect(act).toHaveBeenCalledWith({ action: "suspend", id: mockCloudComputerId });
    await expect(
      handleCloudComputerAct(context)(event, {
        bridgeToken: "capability",
        input: { action: "reboot" },
      }),
    ).rejects.toThrow();
    await expect(
      handleCloudComputerRead(context)(event, { bridgeToken: "wrong", input: undefined }),
    ).rejects.toThrow();
  });

  it("refuses any other window", async () => {
    const { context, event, read } = setup({ workspace: false, account: true });
    await expect(
      handleCloudComputerRead(context)(event, { bridgeToken: "capability", input: undefined }),
    ).rejects.toThrow("Only the application window");
    expect(read).not.toHaveBeenCalled();
  });

  it("says there is no Account in a build without one", async () => {
    const { context, event } = setup({ workspace: true, account: false });
    expect(
      await handleCloudComputerRead(context)(event, {
        bridgeToken: "capability",
        input: undefined,
      }),
    ).toMatchObject({ ok: false, failure: { kind: "unavailable" } });
  });
});
