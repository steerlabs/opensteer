const { requireCanonicalReleaseIdentity } = require("../../../scripts/release-identity.cjs");

function desktopReleaseMetadata(repositoryRoot, environment = process.env, options = {}) {
  const identity = requireCanonicalReleaseIdentity(repositoryRoot, environment, options);
  const beta =
    JSON.parse(
      require("node:fs").readFileSync(
        require("node:path").join(repositoryRoot, "package.json"),
        "utf8",
      ),
    ).version === `${identity.version}-insider`;
  const version = identity.version + (beta ? "-insider" : "");
  return Object.freeze({
    builderArguments: Object.freeze([
      `-c.buildVersion=${identity.version}`,
      `-c.extraMetadata.version=${version}`,
      `-c.productName=${beta ? "Opensteer (Beta)" : "Opensteer"}`,
      "-c.mac.executableName=Opensteer",
      `-c.mac.bundleShortVersion=${identity.version}`,
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
    appInfo.buildVersion !== identity.version ||
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    appInfo.version !== manifest.version ||
    ![identity.version, `${identity.version}-insider`].includes(manifest.version) ||
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
