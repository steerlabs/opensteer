const { requireCanonicalReleaseIdentity } = require("../../../scripts/release-identity.cjs");

function desktopReleaseMetadata(repositoryRoot, environment = process.env, options = {}) {
  const identity = requireCanonicalReleaseIdentity(repositoryRoot, environment, options);
  const track = environment.OPENSTEER_RELEASE_TRACK ?? "stable";
  if (track !== "beta" && track !== "stable") throw new Error("Unknown release track.");
  const beta = track === "beta";
  const version = identity.version + (beta ? "-insider" : "");
  return Object.freeze({
    builderArguments: Object.freeze([
      `-c.buildVersion=${identity.version}`,
      `-c.extraMetadata.version=${version}`,
      `-c.productName=${beta ? "Opensteer (Beta)" : "Opensteer"}`,
      `-c.mac.bundleShortVersion=${identity.version}`,
      `-c.extraMetadata.opensteerBuild.version=${identity.version}`,
      `-c.extraMetadata.opensteerBuild.sourceRevision=${identity.sourceRevision}`,
    ]),
    identity,
    packageVersion: version,
  });
}

function verifyPackagedDesktopRelease(manifest, appInfo, identity, packageVersion) {
  if (
    !appInfo ||
    typeof appInfo !== "object" ||
    Array.isArray(appInfo) ||
    appInfo.buildVersion !== identity.version ||
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    appInfo.version !== packageVersion ||
    manifest.version !== packageVersion ||
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
