import type { VoiceMediaPort } from "@opensteer/client/voice";
import { Linking } from "react-native";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

const awakeTag = "opensteer-voice";

export function loadVoiceMediaPort(
  present: boolean,
  load: () => typeof import("react-native-webrtc"),
): VoiceMediaPort | null {
  return present ? createVoiceMediaPort(load()) : null;
}

export function createVoiceMediaPort(rtc: typeof import("react-native-webrtc")): VoiceMediaPort {
  // The library implements the browser media subset used by the provider, with
  // native stream/track objects. Keep that type mismatch at the SDK boundary.
  const media = rtc.mediaDevices as unknown as Pick<MediaDevices, "getUserMedia">;
  const PeerConnection = rtc.RTCPeerConnection as unknown as typeof RTCPeerConnection;
  return {
    async getUserMedia(constraints) {
      try {
        return await media.getUserMedia({ ...constraints, video: false });
      } catch (cause) {
        // RN WebRTC calls OS microphone refusal SecurityError.
        if (
          typeof cause === "object" &&
          cause !== null &&
          "name" in cause &&
          cause.name === "SecurityError"
        ) {
          const error = new Error("Microphone permission denied", { cause });
          error.name = "NotAllowedError";
          throw error;
        }
        throw cause;
      }
    },
    createPeerConnection: (configuration) => new PeerConnection(configuration),
    playRemote(stream) {
      // WebRTC renders remote audio natively; there is no HTML audio element.
      const tracks = stream.getAudioTracks();
      for (const track of tracks) track.enabled = true;
      return () => {
        for (const track of tracks) track.enabled = false;
      };
    },
    unavailableReason: () => null,
    openMicrophoneSettings: () => {
      void Linking.openSettings().catch(() => {});
    },
    keepAwake(on) {
      if (on) void activateKeepAwakeAsync(awakeTag).catch(() => {});
      else void deactivateKeepAwake(awakeTag).catch(() => {});
    },
  };
}
