import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const phone =
  require("../scripts/release-agent-phone.cjs") as typeof import("../scripts/release-agent-phone.cjs");

it("producer receipt binds inspected release bytes, signer, manifest and source", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "phone-receipt-"));
  const identity = { sourceRevision: "a".repeat(40), version: "1.2.3" };
  try {
    const apk = path.join(directory, "opensteer-agent-phone.apk");
    writeFileSync(apk, "fixture APK");
    writeFileSync(
      path.join(directory, "apksigner"),
      `#!/bin/sh\nprintf '%s\\n' 'Verified using v2 scheme (APK Signature Scheme v2): true' 'Signer #1 certificate SHA-256 digest: ${phone.agentPhoneReleaseSignerSha256}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(directory, "aapt2"),
      "#!/bin/sh\nprintf \"package: name='com.opensteer.agentphone' versionCode='1002003' versionName='1.2.3'\\nsdkVersion:'30'\\n\"\n",
      { mode: 0o755 },
    );
    const manifest = path.join(directory, "agent-phone.json");
    writeFileSync(manifest, JSON.stringify(phone.inspectAgentPhoneApk(apk, directory, "release")));
    const receiptSha256 = phone.writeAgentPhoneReleaseReceipt(directory, identity, directory);
    const receipt = path.join(directory, phone.agentPhoneReceiptName);
    expect(
      phone.verifyAgentPhoneRelease(directory, receipt, {
        ...identity,
        receiptSha256,
        buildTools: directory,
      }),
    ).toMatchObject(identity);
    expect(() =>
      phone.verifyAgentPhoneRelease(directory, receipt, {
        ...identity,
        sourceRevision: "b".repeat(40),
        receiptSha256,
        buildTools: directory,
      }),
    ).toThrow(/source/);
    const bytes = readFileSync(manifest);
    writeFileSync(manifest, bytes + "\n");
    expect(() =>
      phone.verifyAgentPhoneRelease(directory, receipt, {
        ...identity,
        receiptSha256,
        buildTools: directory,
      }),
    ).toThrow(/manifest/);
    writeFileSync(manifest, bytes);
    writeFileSync(apk, "tampered APK");
    expect(() =>
      phone.verifyAgentPhoneRelease(directory, receipt, {
        ...identity,
        receiptSha256,
        buildTools: directory,
      }),
    ).toThrow(/differs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
