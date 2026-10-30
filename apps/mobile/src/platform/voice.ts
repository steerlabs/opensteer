import { NativeModules } from "react-native";
import { loadVoiceMediaPort } from "./voice-adapter.js";

// Requiring WebRTC evaluates native event emitters. An OTA update in an older
// binary must check for the module before even evaluating the package.
export const voiceMediaPort = loadVoiceMediaPort(
  Boolean(NativeModules.WebRTCModule),
  () => require("react-native-webrtc") as typeof import("react-native-webrtc"),
);
