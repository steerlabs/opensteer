import { describe, expect, it, vi } from "vitest";
import { ComputerAppSubmissionNotStartedError } from "./computer-app-hub.js";
import { sendComputerAppFrame } from "./computer-app-frame-send.js";

type Socket = Parameters<typeof sendComputerAppFrame>[0];

function socket(input: {
  readonly bufferedAmount?: number;
  readonly callbackError?: Error;
  readonly readyState?: number;
}) {
  const send = vi.fn((_frame: string, callback: (error?: Error) => void) => {
    callback(input.callbackError);
  });
  return {
    send,
    socket: {
      OPEN: 1,
      bufferedAmount: input.bufferedAmount ?? 0,
      readyState: input.readyState ?? 1,
      send,
    } as unknown as Socket,
  };
}

describe("sendComputerAppFrame", () => {
  it("identifies a closed socket as definitely not submitted", async () => {
    const target = socket({ readyState: 3 });
    const error = await sendComputerAppFrame(target.socket, { type: "invoke" }, 1_024).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ComputerAppSubmissionNotStartedError);
    expect(error).toMatchObject({ close: null });
    expect(target.send).not.toHaveBeenCalled();
  });

  it("identifies a frame over the outbound buffer bound before asking the hub to close", async () => {
    const target = socket({ bufferedAmount: 1_024 });
    const error = await sendComputerAppFrame(target.socket, { type: "invoke" }, 1_024).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ComputerAppSubmissionNotStartedError);
    expect(error).toMatchObject({
      close: { code: 4009, reason: "slow module consumer" },
    });
    expect(target.send).not.toHaveBeenCalled();
  });

  it("keeps a callback error distinct after handing the frame to the socket", async () => {
    const callbackError = new Error("socket callback failed");
    const target = socket({ callbackError });
    await expect(sendComputerAppFrame(target.socket, { type: "invoke" }, 1_024)).rejects.toBe(
      callbackError,
    );
    expect(target.send).toHaveBeenCalledOnce();
  });
});
