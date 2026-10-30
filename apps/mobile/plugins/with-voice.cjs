const { withAppDelegate, withMainApplication, withInfoPlist } = require("expo/config-plugins");

// Use a speaker default, never a forced speaker override: OS routing must still
// follow headsets. Android media output also follows Bluetooth without scan or
// connect permissions; voice has no device picker or background service.
module.exports = function withVoice(config) {
  config = withInfoPlist(config, (next) => {
    // The upstream WebRTC plugin unconditionally adds this video-only key.
    delete next.modResults.NSCameraUsageDescription;
    return next;
  });
  config = withAppDelegate(config, (next) => {
    const anchor = "    let delegate = ReactNativeDelegate()";
    const code = `    let voiceAudio = RTCAudioSessionConfiguration.webRTC()
    voiceAudio.categoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
    RTCAudioSessionConfiguration.setWebRTC(voiceAudio)
`;
    if (!next.modResults.contents.includes(anchor))
      throw new Error("Voice: missing AppDelegate anchor");
    next.modResults.contents = next.modResults.contents
      .replace("import Expo", "import Expo\ninternal import WebRTC")
      .replace(anchor, code + anchor);
    return next;
  });
  return withMainApplication(config, (next) => {
    const anchor = "    super.onCreate()";
    const code = `    val voiceAudio = android.media.AudioAttributes.Builder()
      .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
      .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    com.oney.WebRTCModule.WebRTCModuleOptions.getInstance().audioDeviceModule =
      org.webrtc.audio.JavaAudioDeviceModule.builder(this)
        .setAudioAttributes(voiceAudio).createAudioDeviceModule()
`;
    if (!next.modResults.contents.includes(anchor))
      throw new Error("Voice: missing MainApplication anchor");
    next.modResults.contents = next.modResults.contents.replace(anchor, anchor + "\n" + code);
    return next;
  });
};
