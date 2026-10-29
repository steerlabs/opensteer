const { requireCanonicalReleaseIdentity } = require("../../../scripts/release-identity.cjs");

function desktopReleaseMetadata(repositoryRoot, environment = process.env, options = {}) {
  const identity = requireCanonicalReleaseIdentity(repositoryRoot, environment, options);
  return Object.freeze({
    builderArguments: Object.freeze([
      `-c.buildVersion=${identity.version}`,
      `-c.extraMetadata.version=${identity.version}`,
      `-c.extraMetadata.opensteerBuild.version=${identity.version}`,
      `-c.extraMetadata.opensteerBuild.sourceRevision=${identity.sourceRevision}`,
    ]),
    identity,
  });
}

function verifyPackagedDesktopRelease(manifest, appInfo, identity) {
  if (
    !appInfo ||
    typeof appInfo !== "object" ||
    Array.isArray(appInfo) ||
    appInfo.version !== identity.version ||
    appInfo.buildVersion !== identity.version ||
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.version !== identity.version ||
    !manifest.opensteerBuild ||
    typeof manifest.opensteerBuild !== "object" ||
    Array.isArray(manifest.opensteerBuild) ||
    manifest.opensteerBuild.version !== identity.version ||
    manifest.opensteerBuild.sourceRevision !== identity.sourceRevision
  ) {
    throw new Error("Packaged Desktop release identity does not match its canonical source.");
  }
}

module.exports = { desktopReleaseMetadata, verifyPackagedDesktopRelease };
