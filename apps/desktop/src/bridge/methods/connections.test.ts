import type { IpcMainInvokeEvent } from "electron";
import { desktopRefusalWords, settleDesktopAccessAnswer } from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import { DeploymentAccessRefusal } from "../../connections/deployment-access-service.js";
import type { DesktopBridgeContext } from "../context.js";
import { handleLinkPersonal, handleSelect } from "./connections.js";

/*
 * The one way a refusal the access service makes on purpose reaches the window: answered as its
 * sentence, read by the preload, thrown on as that sentence. Any other failure stays a fault.
 */

const deploymentId = "dep_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("an access operation's answer", () => {
  it("carries a refusal's sentence to the window as it is", async () => {
    const select = vi.fn(async () => {
      throw new DeploymentAccessRefusal("Lab server is no longer in your Opensteers.");
    });
    const answer = await handleSelect(bridgeContext({ select }))(event(), {
      bridgeToken: "b".repeat(43),
      input: { deploymentId },
    });
    expect(answer).toEqual({ refused: "Lab server is no longer in your Opensteers." });
    // What the preload throws on, and what the window reads from it.
    let thrown: unknown;
    try {
      settleDesktopAccessAnswer(answer);
    } catch (error) {
      thrown = error;
    }
    expect(desktopRefusalWords(thrown)).toBe("Lab server is no longer in your Opensteers.");
  });

  it("answers nothing on success, and the preload throws nothing", async () => {
    const answer = await handleLinkPersonal(bridgeContext({ linkPersonal: async () => undefined }))(
      event(),
      { bridgeToken: "b".repeat(43) },
    );
    expect(answer).toBeUndefined();
    expect(() => settleDesktopAccessAnswer(answer)).not.toThrow();
  });

  it("throws any other failure as the fault it is, with no words for a person", async () => {
    const fault = new Error("journal row 7 failed its integrity check");
    await expect(
      handleLinkPersonal(
        bridgeContext({
          linkPersonal: async () => {
            throw fault;
          },
        }),
      )(event(), { bridgeToken: "b".repeat(43) }),
    ).rejects.toBe(fault);
    expect(desktopRefusalWords(fault)).toBeNull();
    // A thing that merely looks like the answer, but isn't one, carries no words either.
    expect(desktopRefusalWords({ refused: "x", words: "x" })).toBeNull();
  });
});

function bridgeContext(access: Record<string, unknown>): DesktopBridgeContext {
  return {
    accessSenders: new Set(),
    options: { access, bridgeToken: "b".repeat(43) },
  } as unknown as DesktopBridgeContext;
}

function event(url = "app://opensteer/computers"): IpcMainInvokeEvent {
  const mainFrame = { url };
  return {
    sender: { id: 7, isDestroyed: () => false, mainFrame, once: vi.fn(), send: vi.fn() },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
