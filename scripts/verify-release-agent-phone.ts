import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  androidBuildTools,
  inspectAgentPhoneApk,
  readAgentPhoneReleaseReceipt,
  verifyAgentPhoneRelease,
} from "./release-agent-phone.cjs";
import { runBounded } from "./command-runner.js";

// Real APK qualification: the failures above are exercised without provider,
// registry, notarization or Git writes. Keep all mutation under evidence-dir.
const { values } = parseArgs({
  options: {
    artifact: { type: "string" },
    "debug-apk": { type: "string" },
    "evidence-dir": { type: "string" },
    "receipt-sha256": { type: "string" },
  },
});
if (!values.artifact || !values["debug-apk"] || !values["evidence-dir"])
  throw new Error(
    "Usage: pnpm exec tsx scripts/verify-release-agent-phone.ts --artifact <directory> --debug-apk <apk> --evidence-dir <directory> --receipt-sha256 <digest>",
  );
const source = path.resolve(values.artifact);
const directory = path.resolve(values["evidence-dir"]);
const receiptPath = path.join(source, "agent-phone-release.json");
const receiptHash = values["receipt-sha256"];
if (!receiptHash) throw new Error("The trusted release receipt SHA-256 is required.");
const receipt = readAgentPhoneReleaseReceipt(receiptPath, receiptHash);
const identity = { sourceRevision: receipt.sourceRevision, version: receipt.version };
await mkdir(directory, { recursive: true });
const require = createRequire(import.meta.url);
const { verifyAgentPhone } = require("../apps/desktop/scripts/after-pack.cjs");
const results: { name: string; error?: string }[] = [];
verifyAgentPhoneRelease(source, receiptPath, { ...identity, receiptSha256: receiptHash });
results.push({ name: "permanent signer, non-debuggable APK and trusted receipt verified" });

async function stage(name: string) {
  const resources = path.join(directory, name);
  const target = path.join(resources, "agent-phone");
  await mkdir(target, { recursive: true });
  for (const file of ["opensteer-agent-phone.apk", "agent-phone.json"])
    await copyFile(path.join(source, file), path.join(target, file));
  return { resources, target };
}
async function reject(name: string, mutate: (target: string) => Promise<void>) {
  const { resources, target } = await stage(name);
  await mutate(target);
  let error: string | undefined;
  try {
    verifyAgentPhoneRelease(target, receiptPath, { ...identity, receiptSha256: receiptHash });
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  assert.ok(error, `${name} was accepted`);
  assert.throws(() => verifyAgentPhone(resources, true), `${name} passed Desktop after-pack`);
  results.push({ name, error });
}
process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT = receiptPath;
process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256 = receiptHash;
process.env.OPENSTEER_SOURCE_REVISION = identity.sourceRevision;
process.env.OPENSTEER_RELEASE_VERSION = identity.version;
const valid = await stage("valid");
verifyAgentPhone(valid.resources, true);
results.push({ name: "Desktop after-pack accepted the exact release APK" });
await reject("missing-apk", async (target) => {
  await unlink(path.join(target, "opensteer-agent-phone.apk"));
});
await reject("debug-apk-with-forged-manifest", async (target) => {
  const bytes = await readFile(values["debug-apk"]!);
  await writeFile(path.join(target, "opensteer-agent-phone.apk"), bytes);
  assert.throws(
    () =>
      inspectAgentPhoneApk(
        path.join(target, "opensteer-agent-phone.apk"),
        androidBuildTools(),
        "release",
      ),
    /debuggability/u,
  );
  const manifest = JSON.parse(await readFile(path.join(target, "agent-phone.json"), "utf8"));
  await writeFile(
    path.join(target, "agent-phone.json"),
    JSON.stringify({
      ...manifest,
      apkSha256: createHash("sha256").update(bytes).digest("hex"),
      apkSize: bytes.length,
    }),
  );
});
const tools = androidBuildTools();
const throwawayStore = path.join(directory, "throwaway.p12");
await runBounded("keytool", [
  "-genkeypair",
  "-keystore",
  throwawayStore,
  "-storetype",
  "PKCS12",
  "-alias",
  "qualification",
  "-storepass",
  "local-qualification-only",
  "-keypass",
  "local-qualification-only",
  "-dname",
  "CN=Local rejection qualification",
  "-keyalg",
  "RSA",
  "-keysize",
  "2048",
  "-validity",
  "1",
]);
await reject("wrong-release-signer", async (target) => {
  const apk = path.join(target, "opensteer-agent-phone.apk");
  await runBounded(path.join(tools, "apksigner"), [
    "sign",
    "--ks",
    throwawayStore,
    "--ks-key-alias",
    "qualification",
    "--ks-pass",
    "pass:local-qualification-only",
    apk,
  ]);
  assert.throws(() => inspectAgentPhoneApk(apk, tools, "release"), /permanent release signer/u);
});
await reject("changed-manifest", async (target) => {
  await writeFile(path.join(target, "agent-phone.json"), "{}\n");
});
assert.throws(() =>
  verifyAgentPhoneRelease(source, receiptPath, { ...identity, receiptSha256: "0".repeat(64) }),
);
assert.throws(() =>
  verifyAgentPhoneRelease(source, receiptPath, {
    ...identity,
    sourceRevision: "0".repeat(40),
    receiptSha256: receiptHash,
  }),
);
results.push({ name: "changed receipt hash and source identity rejected" });
const artifact = path.join(directory, "result.json");
await writeFile(
  artifact,
  JSON.stringify({ identity, receiptHash, receipt, results }, null, 2) + "\n",
);
process.stdout.write(`Agent Phone release qualification: ${artifact}\n`);
