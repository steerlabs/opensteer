import { createHash } from "node:crypto";
import {
  AgentPhoneArtifactManifestSchema,
  AgentPhoneReleaseReceiptSchema,
  agentPhoneReleaseSignerSha256,
  type AgentPhoneArtifactManifest,
  type AgentPhoneReleaseReceipt,
} from "@opensteer/protocol";

export interface AgentPhoneUpdateRelease {
  readonly apk: Buffer;
  readonly manifest: AgentPhoneArtifactManifest;
  readonly manifestJson: string;
  readonly receipt: AgentPhoneReleaseReceipt;
}

/** Only immutable distribution bytes already verified at Host startup reach this boundary. */
export function phoneUpdateRelease(
  files: ReadonlyMap<string, Buffer>,
  hostVersion: string,
): AgentPhoneUpdateRelease | null {
  const apk = files.get("agent-phone/opensteer-agent-phone.apk");
  const manifestBytes = files.get("agent-phone/agent-phone.json");
  const receiptBytes = files.get("agent-phone/agent-phone-release.json");
  // Development bundles may carry an unsigned/debug USB artifact without a receipt.
  if (!apk || !manifestBytes || !receiptBytes) return null;
  const manifest = AgentPhoneArtifactManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const receipt = AgentPhoneReleaseReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const version = manifest.versionName.split(".").map(Number);
  if (
    manifest.buildType !== "release" ||
    manifest.signingCertSha256 !== agentPhoneReleaseSignerSha256 ||
    receipt.signingCertSha256 !== agentPhoneReleaseSignerSha256 ||
    manifest.versionName !== hostVersion ||
    receipt.version !== manifest.versionName ||
    version.length !== 3 ||
    version.some((part) => !Number.isSafeInteger(part) || part < 0) ||
    (version[1] ?? 1000) >= 1000 ||
    (version[2] ?? 1000) >= 1000 ||
    manifest.versionCode !==
      (version[0] ?? 0) * 1_000_000 + (version[1] ?? 0) * 1000 + (version[2] ?? 0) ||
    manifest.apkSize !== apk.byteLength ||
    receipt.apkSize !== apk.byteLength ||
    manifest.apkSha256 !== hash(apk) ||
    receipt.apkSha256 !== manifest.apkSha256 ||
    receipt.manifestSha256 !== hash(manifestBytes)
  )
    throw new Error("Agent Phone self-update release differs from its verified receipt");
  return { apk, manifest, manifestJson: manifestBytes.toString("utf8"), receipt };
}

export function agentPhoneVersionCode(version: string): number | null {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) return null;
  const [major, minor, patch] = version.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    minor >= 1000 ||
    patch >= 1000
  )
    return null;
  const code = major * 1_000_000 + minor * 1000 + patch;
  return Number.isSafeInteger(code) ? code : null;
}
