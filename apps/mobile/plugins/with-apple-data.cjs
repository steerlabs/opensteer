const { withPodfile } = require("expo/config-plugins");

// Expo autolinking registers modules that expose a Swift Module class. This
// SwiftPM/pod data library has no JS module; add its one local pod explicitly.
module.exports = function withAppleData(config) {
  return withPodfile(config, (next) => {
    const anchor = "  use_expo_modules!";
    if (!next.modResults.contents.includes(anchor)) {
      throw new Error("The generated Podfile has no Expo module target.");
    }
    const pod = "  pod 'OpensteerAppleData', :path => '../../../packages/apple-data'";
    if (!next.modResults.contents.includes(pod)) {
      next.modResults.contents = next.modResults.contents.replace(anchor, `${anchor}\n${pod}`);
    }
    return next;
  });
};
