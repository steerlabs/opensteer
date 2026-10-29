const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, writeFileSync, renameSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { z } = require("zod");

// Android preserves this certificate across updates. Changing it strands every
// installed phone; release config selects key custody, never a different signer.
const {
  signingCertSha256: agentPhoneReleaseSignerSha256,
} = require("../packages/protocol/src/agent-phone-release.json");
const agentPhoneBuildToolsVersion = "36.0.0";
const agentPhoneReceiptName = "agent-phone-release.json";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const agentPhoneReleaseReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
  apkSha256: sha256,
  apkSize: z
    .number()
    .int()
    .positive()
    .max(24 * 1024 * 1024),
  manifestSha256: sha256,
  signingCertSha256: z.literal(agentPhoneReleaseSignerSha256),
});

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function readArtifactFile(filename) {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.size > 24 * 1024 * 1024)
    throw new Error(`Agent Phone release input must be a bounded regular file: ${filename}`);
  return readFileSync(filename);
}
function androidBuildTools(environment = process.env) {
  const sdk = environment.ANDROID_HOME ?? path.join(homedir(), "Library/Android/sdk");
  return path.join(sdk, "build-tools", agentPhoneBuildToolsVersion);
}
function androidTool(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Agent Phone ${path.basename(command)} verification failed.`, {
      cause: result.error,
    });
  return result.stdout;
}

function inspectAgentPhoneApk(apk, buildTools, buildType) {
  const bytes = readArtifactFile(apk);
  const certificates = androidTool(path.join(buildTools, "apksigner"), [
    "verify",
    "--verbose",
    "--print-certs",
    apk,
  ]);
  if (!/^Verified using v[23] scheme \(APK Signature Scheme v[23]\): true$/mu.test(certificates))
    throw new Error("Agent Phone APK must use signature scheme v2 or v3.");
  const signers = [
    ...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$/gmu),
  ];
  if (signers.length !== 1) throw new Error("Agent Phone APK must have exactly one signer.");
  const signingCertSha256 = signers[0][1];
  const badging = androidTool(path.join(buildTools, "aapt2"), ["dump", "badging", apk]);
  const identity = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/mu.exec(
    badging,
  );
  const minSdk = /^(?:minSdkVersion|sdkVersion):'(\d+)'$/mu.exec(badging);
  if (!identity || !minSdk || identity[1] !== "com.opensteer.agentphone" || Number(minSdk[1]) < 30)
    throw new Error("Agent Phone APK package/minimum SDK is invalid.");
  if (/^application-debuggable\s*$/mu.test(badging) !== (buildType === "debug"))
    throw new Error(`Agent Phone APK does not have the debuggability of its ${buildType} build.`);
  if (buildType === "release" && signingCertSha256 !== agentPhoneReleaseSignerSha256)
    throw new Error("Agent Phone APK does not carry the permanent release signer.");
  return {
    apkSha256: hash(bytes),
    apkSize: bytes.length,
    buildType,
    minSdk: Number(minSdk[1]),
    packageName: identity[1],
    signingCertSha256,
    versionCode: Number(identity[2]),
    versionName: identity[3],
  };
}

function readAgentPhoneReleaseReceipt(filename, expectedSha256) {
  const expected = sha256.parse(expectedSha256);
  const bytes = readArtifactFile(filename);
  if (hash(bytes) !== expected)
    throw new Error("Agent Phone release receipt changed from the trusted digest.");
  return agentPhoneReleaseReceiptSchema.parse(JSON.parse(bytes.toString("utf8")));
}

function verifyAgentPhoneRelease(directory, receiptPath, options = {}) {
  const receipt = readAgentPhoneReleaseReceipt(receiptPath, options.receiptSha256);
  if (receipt.sourceRevision !== options.sourceRevision || receipt.version !== options.version)
    throw new Error("Agent Phone receipt belongs to a different release source/version.");
  const manifestBytes = readArtifactFile(path.join(directory, "agent-phone.json"));
  if (hash(manifestBytes) !== receipt.manifestSha256)
    throw new Error("Agent Phone manifest differs from the trusted release receipt.");
  const actual = inspectAgentPhoneApk(
    path.join(directory, "opensteer-agent-phone.apk"),
    options.buildTools ?? androidBuildTools(),
    "release",
  );
  const manifest = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(manifestBytes.toString("utf8")));
  if (
    Object.keys(manifest).length !== Object.keys(actual).length ||
    Object.entries(actual).some(([key, value]) => manifest[key] !== value) ||
    actual.apkSha256 !== receipt.apkSha256 ||
    actual.apkSize !== receipt.apkSize ||
    actual.signingCertSha256 !== receipt.signingCertSha256 ||
    actual.versionName !== receipt.version
  )
    throw new Error("Agent Phone APK/manifest differs from the trusted release receipt.");
  return receipt;
}

/** The producer binds the inspected APK and exact manifest bytes to its source. */
function writeAgentPhoneReleaseReceipt(directory, identity, buildTools = androidBuildTools()) {
  const apk = inspectAgentPhoneApk(
    path.join(directory, "opensteer-agent-phone.apk"),
    buildTools,
    "release",
  );
  if (apk.versionName !== identity.version) throw Error("APK version differs from source");
  const receipt = agentPhoneReleaseReceiptSchema.parse({
    schemaVersion: 1,
    sourceRevision: identity.sourceRevision,
    version: identity.version,
    apkSha256: apk.apkSha256,
    apkSize: apk.apkSize,
    manifestSha256: hash(readArtifactFile(path.join(directory, "agent-phone.json"))),
    signingCertSha256: apk.signingCertSha256,
  });
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  const filename = path.join(directory, agentPhoneReceiptName);
  writeFileSync(`${filename}.partial`, bytes, { mode: 0o600 });
  renameSync(`${filename}.partial`, filename);
  const receiptSha256 = hash(bytes);
  verifyAgentPhoneRelease(directory, filename, { ...identity, receiptSha256, buildTools });
  return receiptSha256;
}

module.exports = {
  writeAgentPhoneReleaseReceipt,
  agentPhoneReleaseSignerSha256,
  agentPhoneBuildToolsVersion,
  agentPhoneReceiptName,
  agentPhoneReleaseReceiptSchema,
  androidBuildTools,
  inspectAgentPhoneApk,
  readAgentPhoneReleaseReceipt,
  verifyAgentPhoneRelease,
};

if (require.main === module) {
  const [directory, receiptPath] = process.argv.slice(2);
  if (!directory || !receiptPath)
    throw new Error("Usage: node scripts/release-agent-phone.cjs <directory> <trusted-receipt>");
  const receipt = verifyAgentPhoneRelease(directory, receiptPath, {
    receiptSha256: process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256,
    sourceRevision: process.env.OPENSTEER_SOURCE_REVISION,
    version: process.env.OPENSTEER_RELEASE_VERSION,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
