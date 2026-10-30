import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Linking: { openSettings: vi.fn(async () => {}) } }));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: vi.fn(async () => {}),
  deactivateKeepAwake: vi.fn(async () => {}),
}));
import { Linking } from "react-native";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { loadVoiceMediaPort } from "./voice-adapter.js";

describe("native voice media", () => {
  it("never evaluates WebRTC in an older binary", () => {
    const load = vi.fn(() => {
      throw new Error("Native module missing");
    });
    expect(loadVoiceMediaPort(false, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
  it("maps native capture, refusal, peer creation, playback and screen wake", async () => {
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    const track = { enabled: false };
    const capture = vi.fn(async (_constraints: unknown) => stream);
    const pc = vi.fn(function (this: { configuration: unknown }, configuration: unknown) {
      this.configuration = configuration;
    });
    const sdk = {
      mediaDevices: { getUserMedia: capture },
      RTCPeerConnection: pc,
    } as unknown as typeof import("react-native-webrtc");
    const port = loadVoiceMediaPort(true, () => sdk)!;
    expect(port.unavailableReason()).toBeNull();
    expect(await port.getUserMedia({ audio: true })).toBe(stream);
    expect(capture).toHaveBeenCalledWith({ audio: true, video: false });
    const nativeTrack = { stop: vi.fn() };
    const native = { getTracks: () => [nativeTrack], release: vi.fn() };
    port.releaseStream(native as unknown as MediaStream);
    expect(nativeTrack.stop).toHaveBeenCalledTimes(1);
    expect(native.release).toHaveBeenCalledWith(true);
    const configuration = { iceServers: [] };
    port.createPeerConnection(configuration);
    expect(pc).toHaveBeenCalledWith(configuration);
    const stop = port.playRemote(stream);
    expect(track.enabled).toBe(true);
    stop();
    stop();
    expect(track.enabled).toBe(false);
    port.keepAwake?.(true);
    port.keepAwake?.(false);
    expect(activateKeepAwakeAsync).toHaveBeenCalledWith("opensteer-voice");
    expect(deactivateKeepAwake).toHaveBeenCalledWith("opensteer-voice");
    port.openMicrophoneSettings?.();
    expect(Linking.openSettings).toHaveBeenCalled();
    capture.mockRejectedValueOnce({ name: "SecurityError" });
    await expect(port.getUserMedia({ audio: true })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    const failure = new Error("No microphone");
    capture.mockRejectedValueOnce(failure);
    await expect(port.getUserMedia({ audio: true })).rejects.toBe(failure);
  });
});
