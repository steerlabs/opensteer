const { execFileSync } = require("node:child_process");
const { X509Certificate, createHash } = require("node:crypto");
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { readSigningMode } = require("./signing-input.cjs");
const { join, resolve } = require("node:path");
const capability = "com.apple.developer.web-browser.public-key-credential";
function execute(program, args, input) {
  return execFileSync(program, args, {
    input,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function regular(filename) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Passkey signing input must be a regular file");
  return readFileSync(filename);
}
function plist(bytes) {
  return JSON.parse(execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], bytes));
}
function signedEntitlements(filename) {
  const bytes = execute("/usr/bin/codesign", ["-d", "--entitlements", ":-", filename]);
  return bytes ? plist(bytes) : {};
}
function passkeyInputPaths(env, channel) {
  if (channel !== "stable" && channel !== "beta")
    throw new Error("Unknown passkey signing channel");
  const prefix = `OPENSTEER_PASSKEYS_${channel.toUpperCase()}`;
  const profile = env[`${prefix}_PROFILE`];
  const entitlements = env[`${prefix}_ENTITLEMENTS`];
  if (!profile && !entitlements) return undefined;
  if (env.OPENSTEER_DESKTOP_RELEASE !== "1" || !profile || !entitlements)
    throw new Error("Passkeys require a release profile and entitlement input for this channel");
  return { profile, entitlements };
}
function validatePasskeyEntitlementInput(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    value[capability] !== true
  )
    throw new Error("Passkey entitlement input must contain only the granted browser capability");
}
function validatePasskeyProfile(value, identity, now = Date.now(), certificate) {
  const entitlements = value?.Entitlements;
  if (
    !value ||
    !entitlements ||
    entitlements[capability] !== true ||
    entitlements["com.apple.application-identifier"] !==
      `${identity.teamId}.${identity.bundleId}` ||
    entitlements["com.apple.developer.team-identifier"] !== identity.teamId ||
    !Array.isArray(value.TeamIdentifier) ||
    !value.TeamIdentifier.includes(identity.teamId) ||
    !(Date.parse(value.ExpirationDate) > now) ||
    value.ProvisionsAllDevices !== true ||
    !Array.isArray(value.Platform) ||
    !value.Platform.includes("OSX")
  )
    throw new Error(
      "Passkey profile must grant the capability to this Developer ID app and team and remain current",
    );
  const authorized = value.DeveloperCertificates;
  if (!certificate || !Array.isArray(authorized) || authorized.length < 1 || authorized.length > 32)
    throw new Error("Passkey profile must authorize the signing certificate");
  const leaf = new X509Certificate(certificate).raw;
  const matches = authorized.some((encoded) => {
    if (typeof encoded !== "string" || encoded.length > 65_536)
      throw new Error("Invalid profile certificate");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("Invalid profile certificate");
    return new X509Certificate(bytes).raw.equals(leaf);
  });
  if (!matches) throw new Error("Passkey profile does not authorize the signing certificate");
}
/** Resolve only a valid private-key identity in the selected keychain. Rotated names may be ambiguous. */
function selectedSigningCertificate(signing, command = execute) {
  const identities = command("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    ...(signing.keychain ? [signing.keychain] : []),
  ]);
  const hashes = new Set(
    [...identities.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"\s*$/gmu)]
      .filter((match) => match[2] === signing.identity)
      .map((match) => match[1].toUpperCase()),
  );
  if (hashes.size !== 1) throw new Error("Passkey signing certificate is missing or ambiguous");
  const pem = command("/usr/bin/security", [
    "find-certificate",
    "-a",
    "-c",
    signing.identity,
    "-p",
    ...(signing.keychain ? [signing.keychain] : []),
  ]);
  const certificates = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu),
  ].map((match) => new X509Certificate(match[0]));
  const certificate = certificates.find((value) =>
    hashes.has(value.fingerprint.replaceAll(":", "")),
  );
  if (!certificate) throw new Error("Selected passkey signing certificate was not found");
  return certificate.raw;
}
function signedAppCertificate(appPath, command = execute) {
  const directory = mkdtempSync(join(tmpdir(), "passkey-signature-"));
  try {
    const prefix = join(directory, "certificate");
    command("/usr/bin/codesign", ["-d", "--extract-certificates", prefix, appPath]);
    return new X509Certificate(regular(`${prefix}0`)).raw;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function readProfile(filename) {
  regular(filename);
  const decoded = execute("/usr/bin/security", ["cms", "-D", "-i", filename]);
  const field = (name, format, type) =>
    execute(
      "/usr/bin/plutil",
      ["-extract", name, format, ...(type ? ["-expect", type] : []), "-o", "-", "-"],
      decoded,
    );
  const count = Number(field("DeveloperCertificates", "raw", "array"));
  if (!Number.isInteger(count) || count < 1 || count > 32)
    throw new Error("Invalid profile certificate list");
  return {
    DeveloperCertificates: Array.from({ length: count }, (_, index) =>
      field(`DeveloperCertificates.${index}`, "raw", "data"),
    ),
    Entitlements: JSON.parse(field("Entitlements", "json")),
    TeamIdentifier: JSON.parse(field("TeamIdentifier", "json")),
    ExpirationDate: field("ExpirationDate", "raw"),
    Platform: JSON.parse(field("Platform", "json")),
    ProvisionsAllDevices: field("ProvisionsAllDevices", "raw") === "true",
  };
}
function checkedInputs(env, identity) {
  const inputs = passkeyInputPaths(env, identity.channel);
  if (!inputs) return undefined;
  validatePasskeyEntitlementInput(plist(regular(inputs.entitlements)));
  return inputs;
}
function preparePasskeySigning(desktop, env, identity) {
  const inputs = checkedInputs(env, identity);
  if (!inputs) return [];
  const mode = readSigningMode(env);
  if (mode.mode !== "signed" || mode.signing.teamId !== identity.teamId)
    throw new Error("Passkeys require the selected release signing identity");
  validatePasskeyProfile(
    readProfile(inputs.profile),
    identity,
    Date.now(),
    selectedSigningCertificate(mode.signing),
  );
  const directory = join(desktop, "build/generated/passkeys", identity.channel);
  mkdirSync(directory, { recursive: true });
  const entitlements = join(directory, "entitlements.plist");
  const profile = join(directory, "embedded.provisionprofile");
  const values = {
    ...plist(regular(join(desktop, "build/entitlements.mac.plist"))),
    [capability]: true,
    "com.apple.application-identifier": `${identity.teamId}.${identity.bundleId}`,
    "com.apple.developer.team-identifier": identity.teamId,
  };
  writeFileSync(
    entitlements,
    execute("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], JSON.stringify(values)) + "\n",
  );
  writeFileSync(profile, regular(inputs.profile));
  return [
    `-c.mac.entitlements=${resolve(entitlements)}`,
    `-c.mac.provisioningProfile=${resolve(profile)}`,
  ];
}
function verifyPasskeyAddon(appPath, signed = false, teamId, required = true) {
  const filename = join(
    appPath,
    "Contents/Resources/app.asar.unpacked/dist/passkeys/opensteer-passkeys.node",
  );
  if (!required && !existsSync(filename)) return;
  regular(filename);
  if (
    execute("/usr/bin/lipo", ["-archs", filename]).split(/\s+/u).sort().join(" ") !== "arm64 x86_64"
  )
    throw new Error("Packaged passkey addon must be universal");
  if (!signed) return;
  execute("/usr/bin/codesign", ["--verify", "--strict", filename]);
  if (teamId)
    execute("/usr/bin/codesign", [
      "--verify",
      "-R",
      `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`,
      filename,
    ]);
  if (signedEntitlements(filename)[capability] !== undefined)
    throw new Error("Passkey capability must belong only to the main app");
}
function verifyPasskeySignature(appPath, identity, env = process.env) {
  const inputs = checkedInputs(env, identity);
  const actual = signedEntitlements(appPath);
  const embedded = join(appPath, "Contents/embedded.provisionprofile");
  if (!inputs) {
    if (actual[capability] !== undefined || existsSync(embedded))
      throw new Error("An unprovisioned app must not carry the passkey capability or profile");
    return false;
  }
  if (
    actual[capability] !== true ||
    actual["com.apple.application-identifier"] !== `${identity.teamId}.${identity.bundleId}` ||
    actual["com.apple.developer.team-identifier"] !== identity.teamId
  )
    throw new Error("The main app is missing its granted passkey signing identity");
  const digest = (filename) => createHash("sha256").update(regular(filename)).digest("hex");
  if (digest(embedded) !== digest(inputs.profile))
    throw new Error("The embedded passkey profile differs from the build input");
  validatePasskeyProfile(
    readProfile(embedded),
    identity,
    Date.now(),
    signedAppCertificate(appPath),
  );
  return true;
}
function verifyNoInheritedPasskeyCapability(appPath) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const filename = join(directory, entry.name);
      if (entry.name.endsWith(".app") && signedEntitlements(filename)[capability] !== undefined)
        throw new Error("A helper inherited the main app's passkey capability");
      visit(filename);
    }
  };
  visit(join(appPath, "Contents"));
}
module.exports = {
  passkeyInputPaths,
  validatePasskeyEntitlementInput,
  validatePasskeyProfile,
  selectedSigningCertificate,
  signedAppCertificate,
  preparePasskeySigning,
  verifyPasskeyAddon,
  verifyPasskeySignature,
  verifyNoInheritedPasskeyCapability,
};
