const { spawnSync } = require("node:child_process");
const { lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const { readSigningMode } = require("./signing-input.cjs");
let configuredSigningMode;
function loadSigningMode() {
  // The hook module also loads on Windows/Linux; only macOS operations need Apple authority.
  return (configuredSigningMode ??= readSigningMode());
}
function appleTeamId() {
  const mode = loadSigningMode();
  return mode.mode === "signed" ? mode.signing.teamId : "";
}
const releaseIdentities = Object.freeze({
  beta: Object.freeze({
    bundleId: "com.steerlabs.opensteer.beta",
    channel: "beta",
    productName: "Opensteer Beta",
  }),
  stable: Object.freeze({
    bundleId: "com.opensteer.opensteer",
    channel: "stable",
    productName: "Opensteer",
  }),
});

function desktopReleaseIdentity(channel) {
  const release = releaseIdentities[channel];
  if (!release) throw new Error("The macOS release channel must be beta or stable.");
  return Object.freeze({ ...release, teamId: appleTeamId() });
}

function validateReleaseEntitlements(entitlements, passkeyIdentity) {
  assertRecord(entitlements, "The signed macOS release entitlements");
  // Not Apple events: every command an agent runs descends from this app, so
  // sending in Messages belongs to the Computer Use helper alone.
  const expected = ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"];
  if (passkeyIdentity) {
    const values = {
      "com.apple.developer.web-browser.public-key-credential": true,
      "com.apple.application-identifier": `${passkeyIdentity.teamId}.${passkeyIdentity.bundleId}`,
      "com.apple.developer.team-identifier": passkeyIdentity.teamId,
    };
    for (const [key, value] of Object.entries(values)) {
      if (entitlements[key] !== value)
        throw new Error("The signed passkey entitlement identity differs");
      expected.push(key);
    }
    expected.sort();
  }
  if (!sameStrings(Object.keys(entitlements).sort(), expected)) {
    throw new Error(
      "The signed Electron app must use only the reviewed hardened-runtime entitlements.",
    );
  }
  if (entitlements["com.apple.security.device.audio-input"] !== true) {
    throw new Error("The signed Electron app must retain the audio-input entitlement.");
  }
  if (entitlements["com.apple.security.cs.allow-jit"] !== true) {
    throw new Error("The signed Electron app must retain the hardened-runtime JIT entitlement.");
  }
}

function verifyPackagedMacReleaseIdentity(appPath, identity) {
  const infoPath = join(appPath, "Contents", "Info.plist");
  if (readPlistString(infoPath, "CFBundleIdentifier") !== identity.bundleId) {
    throw new Error(`The packaged app must use bundle ID ${identity.bundleId}.`);
  }
  if (readPlistString(infoPath, "CFBundleName") !== identity.productName) {
    throw new Error(`The packaged app must use product name ${identity.productName}.`);
  }

  const signature = runText("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  if (!signature.split(/\r?\n/u).includes(`Identifier=${identity.bundleId}`)) {
    throw new Error(`The signed app must use code-signing identifier ${identity.bundleId}.`);
  }
  if (!signature.split(/\r?\n/u).includes(`TeamIdentifier=${identity.teamId}`)) {
    throw new Error(`The signed app must use permanent Team ${identity.teamId}.`);
  }
  if (
    !signature
      .split(/\r?\n/u)
      .some((line) => line.startsWith("Authority=Developer ID Application:"))
  ) {
    throw new Error("The signed app must use a Developer ID Application certificate.");
  }
  if (!/^CodeDirectory .* flags=.*\(runtime\)/mu.test(signature)) {
    throw new Error("The signed app must enable the hardened runtime.");
  }
  if (!/^Timestamp=.+/mu.test(signature)) {
    throw new Error("The signed app must carry a secure timestamp.");
  }

  const entitlements = plistFromCommand("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    ":-",
    appPath,
  ]);
  const granted = require("./passkeys-signing.cjs").verifyPasskeySignature(appPath, identity);
  validateReleaseEntitlements(entitlements, granted ? identity : undefined);
}

function readPlistString(filePath, key) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${filePath} must be a real property-list file.`);
  }
  return plistExtract(readFileSync(filePath), key, "raw");
}

function plistFromCommand(executable, arguments_) {
  return plistFromBytes(runBytes(executable, arguments_));
}

function runBytes(executable, arguments_) {
  const result = spawnSync(executable, arguments_, { encoding: null, stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed with exit ${result.status}.`);
  }
  return result.stdout;
}

function runText(executable, arguments_) {
  const result = spawnSync(executable, arguments_, { encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed with exit ${result.status}.`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function plistExtract(contents, key, format) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, format, "-o", "-", "-"], {
    encoding: "utf8",
    input: contents,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`The Apple property list is missing ${key}.`);
  }
  return result.stdout.trim();
}

function plistFromBytes(contents) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: contents,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`plutil failed with exit ${result.status}.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("The Apple property list could not be parsed.", { cause: error });
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a dictionary.`);
  }
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

module.exports = {
  desktopReleaseIdentity,
  validateReleaseEntitlements,
  verifyPackagedMacReleaseIdentity,
};

Object.defineProperties(module.exports, {
  signingMode: { get: loadSigningMode },
  opensteerAppleTeamId: { get: appleTeamId },
});
