import { expect, it, vi } from "vitest";
import { Deferred, type HarnessVoiceCall } from "@opensteer/harness";
import type { CodexStdioClient } from "./process.js";
import { startRealtime } from "./voice.js";
it("waits for an offer and selects V3 without overriding the vendor prompt", async () => {
  const offer = new Deferred<string>();
  const request = vi.fn(async () => ({}));
  const call = { offer: offer.promise, signal: new AbortController().signal } as HarnessVoiceCall;
  const start = startRealtime({ request } as unknown as CodexStdioClient, "thread", call, 100);
  expect(request).not.toHaveBeenCalled();
  offer.resolve("offer");
  await start;
  expect(request).toHaveBeenCalledWith(
    "thread/realtime/start",
    {
      threadId: "thread",
      transport: { type: "webrtc", sdp: "offer" },
      version: "v3",
      clientManagedHandoffs: true,
      includeStartupContext: false,
      outputModality: "audio",
    },
    100,
  );
});
it("bounds a missing offer", async () => {
  vi.useFakeTimers();
  try {
    const call = {
      offer: new Deferred<string>().promise,
      signal: new AbortController().signal,
    } as HarnessVoiceCall;
    const result = expect(
      startRealtime({} as CodexStdioClient, "thread", call, 100),
    ).rejects.toMatchObject({ reason: "voice-ended" });
    await vi.advanceTimersByTimeAsync(100);
    await result;
  } finally {
    vi.useRealTimers();
  }
});
