const { withInfoPlist } = require("expo/config-plugins");

/**
 * Expo also registers the bundle ID as a URL scheme. Ours is the desktop's OAuth
 * scheme, so this app on an Apple silicon Mac could receive the desktop's codes.
 */
function withoutBundleScheme(infoPlist, bundleIdentifier) {
  return {
    ...infoPlist,
    CFBundleURLTypes: (infoPlist.CFBundleURLTypes ?? [])
      .map((type) => ({
        ...type,
        CFBundleURLSchemes: type.CFBundleURLSchemes.filter((scheme) => scheme !== bundleIdentifier),
      }))
      .filter((type) => type.CFBundleURLSchemes.length > 0),
  };
}

module.exports = function withSingleUrlScheme(config) {
  return withInfoPlist(config, (next) => {
    next.modResults = withoutBundleScheme(next.modResults, next.ios?.bundleIdentifier);
    return next;
  });
};
module.exports.withoutBundleScheme = withoutBundleScheme;
