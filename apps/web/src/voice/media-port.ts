import type { VoiceMediaPort } from "@opensteer/client/voice";
import { desktopBridge } from "../desktop/desktop-bridge.js";

/** Shared by the Host-served web page and the bundled desktop renderer. */
export function createBrowserVoiceMediaPort(): VoiceMediaPort {
  const settings = desktopBridge()?.dictation;
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    releaseStream: (stream) => {
      for (const track of stream.getTracks()) track.stop();
    },
    createPeerConnection: (configuration) => new RTCPeerConnection(configuration),
    playRemote(stream) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.srcObject = stream;
      document.body.append(audio);
      return () => {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      };
    },
    unavailableReason() {
      if (!globalThis.isSecureContext) return "insecure-context";
      if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection)
        return "unsupported";
      return null;
    },
    ...(settings
      ? {
          openMicrophoneSettings: () => {
            void settings.openMicrophoneSettings().catch(() => {});
          },
        }
      : {}),
  };
}
