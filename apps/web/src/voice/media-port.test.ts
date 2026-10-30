import { afterEach, expect, it, vi } from "vitest";
import { createBrowserVoiceMediaPort } from "./media-port.js";

vi.mock("../desktop/desktop-bridge.js", () => ({ desktopBridge: () => bridge }));
let bridge: { dictation: { openMicrophoneSettings: ReturnType<typeof vi.fn> } } | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  bridge = null;
});

it("checks availability without requesting consent and forwards capture and RTC options", async () => {
  const stream = {} as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const rtc = vi.fn(function () {});
  vi.stubGlobal("isSecureContext", false);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("RTCPeerConnection", rtc);
  const port = createBrowserVoiceMediaPort();
  expect(port.unavailableReason()).toBe("insecure-context");
  vi.stubGlobal("isSecureContext", true);
  expect(port.unavailableReason()).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
  const constraints = { audio: { echoCancellation: true }, video: false };
  expect(await port.getUserMedia(constraints)).toBe(stream);
  expect(getUserMedia).toHaveBeenCalledWith(constraints);
  const config = { iceServers: [] };
  port.createPeerConnection(config);
  expect(rtc).toHaveBeenCalledWith(config);
  vi.stubGlobal("RTCPeerConnection", undefined);
  expect(port.unavailableReason()).toBe("unsupported");
  vi.stubGlobal("navigator", {});
  expect(port.unavailableReason()).toBe("unsupported");
  expect(port.keepAwake).toBeUndefined();
  expect(port.openMicrophoneSettings).toBeUndefined();
});

it("preserves microphone refusals", async () => {
  const error = new DOMException("refused", "NotAllowedError");
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(error) } });
  await expect(createBrowserVoiceMediaPort().getUserMedia({ audio: true })).rejects.toBe(error);
});

it("plays a stream and releases the audio element on stop without stopping remote tracks", () => {
  const audio = {
    autoplay: false,
    srcObject: null as MediaStream | null,
    pause: vi.fn(),
    remove: vi.fn(),
  };
  const append = vi.fn();
  vi.stubGlobal("document", { createElement: vi.fn().mockReturnValue(audio), body: { append } });
  const stream = {} as MediaStream;
  const stop = createBrowserVoiceMediaPort().playRemote(stream);
  expect(audio.autoplay).toBe(true);
  expect(audio.srcObject).toBe(stream);
  expect(append).toHaveBeenCalledWith(audio);
  stop();
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.srcObject).toBeNull();
  expect(audio.remove).toHaveBeenCalledOnce();
});

it("reuses the desktop microphone settings bridge", () => {
  const openMicrophoneSettings = vi.fn().mockResolvedValue(undefined);
  bridge = { dictation: { openMicrophoneSettings } };
  createBrowserVoiceMediaPort().openMicrophoneSettings?.();
  expect(openMicrophoneSettings).toHaveBeenCalledOnce();
});
