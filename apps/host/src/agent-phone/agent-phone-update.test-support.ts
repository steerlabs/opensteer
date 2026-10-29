import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentPhoneArtifactManifestSchema,
  type AgentPhoneArtifactManifest,
} from "@opensteer/protocol";
import {
  eventually,
  tapView,
  repositoryRoot,
  runCommand,
  type AndroidDevice,
} from "./agent-phone-device.test-support.js";
import type { AgentPhoneUpdateRelease } from "./update-release.js";

/** Test-only release signing never invokes the permanent key or changes product artifacts. */
export async function buildPhoneUpdateFixtures(directory: string, ca: string) {
  const temporary = await mkdtemp(join(tmpdir(), "opensteer-phone-baseline-"));
  const baseline = join(temporary, "source");
  let added = false;
  const close = async () => {
    if (added) {
      await runCommand("git", ["worktree", "remove", "--force", baseline], {
        cwd: repositoryRoot,
        timeoutMs: 120_000,
      });
      added = false;
    }
    await rm(temporary, { force: true, recursive: true });
  };
  try {
    await runCommand("git", ["worktree", "add", "--detach", baseline, "8bfad329"], {
      cwd: repositoryRoot,
    });
    added = true;
    const baselineRevision = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: baseline })
    ).trim();
    await writeFile(
      join(directory, "baseline-install.log"),
      await runCommand("pnpm", ["install", "--frozen-lockfile"], {
        cwd: baseline,
        timeoutMs: 600_000,
      }),
    );
    await writeFile(
      join(directory, "current-source.patch"),
      await runCommand("git", ["diff", "HEAD"], { cwd: repositoryRoot }),
    );
    const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
    const java =
      process.env.JAVA_HOME ?? "/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home";
    const tools = join(sdk, "build-tools/36.0.0");
    const key = join(directory, "update-test.jks");
    if (
      !(await readFile(key).then(
        () => true,
        () => false,
      ))
    )
      await runCommand(join(java, "bin/keytool"), [
        "-genkeypair",
        "-keystore",
        key,
        "-storepass",
        "opensteer-test",
        "-keypass",
        "opensteer-test",
        "-alias",
        "update-test",
        "-dname",
        "CN=Isolated Agent Phone update test",
        "-keyalg",
        "RSA",
        "-validity",
        "30",
      ]);
    const cert = await runCommand(join(java, "bin/keytool"), [
      "-exportcert",
      "-rfc",
      "-keystore",
      key,
      "-storepass",
      "opensteer-test",
      "-alias",
      "update-test",
    ]);
    const der = Buffer.from(cert.replace(/-----[^-]+-----/gu, "").replace(/\s/gu, ""), "base64");
    const signer = createHash("sha256").update(der).digest("hex");
    const build = async (source: string, version: string) => {
      const target = join(directory, version);
      await mkdir(target, { recursive: true });
      const buildLog = await runCommand(
        join(source, "apps/agent-phone/gradlew"),
        [
          "-p",
          join(source, "apps/agent-phone"),
          ":app:assembleUpdateTest",
          "--no-daemon",
          "--max-workers=2",
          `-PopensteerE2eCa=${ca}`,
          `-PopensteerUpdateTestVersion=${version}`,
          `-PopensteerUpdateTestSigner=${signer}`,
          `-PopensteerUpdateTestKeystore=${key}`,
        ],
        { timeoutMs: 600_000 },
      );
      await writeFile(join(target, "build.log"), buildLog);
      const path = join(target, "opensteer-agent-phone.apk");
      await copyFile(
        join(source, "apps/agent-phone/app/build/outputs/apk/updateTest/app-updateTest.apk"),
        path,
      );
      const apk = await readFile(path);
      const badging = await runCommand(join(tools, "aapt2"), ["dump", "badging", path]);
      if (/application-debuggable/u.test(badging))
        throw new Error("Self-update fixtures must be nondebuggable");
      const manifest = AgentPhoneArtifactManifestSchema.parse({
        apkSha256: createHash("sha256").update(apk).digest("hex"),
        apkSize: apk.length,
        buildType: "release",
        minSdk: 30,
        packageName: "com.opensteer.agentphone",
        signingCertSha256: signer,
        versionCode: version
          .split(".")
          .map(Number)
          .reduce((n, part) => n * 1000 + part),
        versionName: version,
      });
      const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
      await writeFile(join(target, "agent-phone.json"), manifestJson);
      return {
        apk,
        manifest,
        manifestJson,
        receipt: {
          schemaVersion: 1 as const,
          sourceRevision: (await runCommand("git", ["rev-parse", "HEAD"], { cwd: source })).trim(),
          version,
          apkSha256: manifest.apkSha256,
          apkSize: apk.length,
          signingCertSha256: signer,
          manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
        },
      };
    };
    const oldRelease = await build(baseline, "0.1.145");
    const next = await build(repositoryRoot, "0.1.149");
    const observer = await buildIdentityObserver(directory, { java, tools, sdk, key });
    await writeFile(
      join(directory, "apk-provenance.json"),
      JSON.stringify(
        {
          baselineRevision,
          baselineProtocol: 3,
          baselineProofFormat: 2,
          baselineIdentity: 1,
          baseline: oldRelease.receipt,
          current: next.receipt,
          signer,
          observerSha256: createHash("sha256")
            .update(await readFile(observer))
            .digest("hex"),
        },
        null,
        2,
      ) + "\n",
    );
    const unsafe = (manifest: AgentPhoneArtifactManifest): AgentPhoneUpdateRelease => {
      const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
      return {
        ...next,
        manifest,
        manifestJson,
        receipt: {
          ...next.receipt,
          version: manifest.versionName,
          signingCertSha256: manifest.signingCertSha256,
          manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
        },
      };
    };
    const rejected: [string, AgentPhoneUpdateRelease][] = [
      [
        "signer-mismatch",
        unsafe({
          ...next.manifest,
          versionCode: 1146,
          versionName: "0.1.146",
          signingCertSha256: "f".repeat(64),
        }),
      ],
      [
        "digest-mismatch",
        {
          ...unsafe({ ...next.manifest, versionCode: 1147, versionName: "0.1.147" }),
          apk: Buffer.from(next.apk).fill(0, 100, 101),
        },
      ],
      ["downgrade", unsafe({ ...next.manifest, versionCode: 1144, versionName: "0.1.144" })],
    ];
    return {
      baseline,
      baselineRevision,
      observer,
      close,
      old: { bytes: oldRelease.apk, manifest: oldRelease.manifest },
      next,
      rejected,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Uses the same window-aware view locator as setup, restricted to Android's installer. */
export async function tapSystemUpdate(device: AndroidDevice) {
  const activity = await eventually(
    "Android system Update activity",
    async () => {
      const dump = await device.shell("dumpsys activity top");
      return [...dump.matchAll(/^\s*ACTIVITY (\S+) /gmu)]
        .map((match) => match[1])
        .find(
          (name) => name?.includes("packageinstaller") && name.endsWith("PackageInstallerActivity"),
        );
    },
    30_000,
  );
  if (!activity) throw new Error("Android has no update confirmation activity");
  await tapView(device, { activity, viewId: "button1", resourceId: "android:id/button1" });
}

/** Independent read-only instrumentation; never calls product identity serializers or writers. */
async function buildIdentityObserver(
  directory: string,
  paths: { java: string; tools: string; sdk: string; key: string },
): Promise<string> {
  const source = join(directory, "identity-observer");
  const classes = join(source, "classes");
  const dex = join(source, "dex");
  await mkdir(classes, { recursive: true });
  await mkdir(dex, { recursive: true });
  const javaSource = `package com.opensteer.agentphone.identityprobe;
import android.app.Instrumentation;
import android.app.Activity;
import android.os.Bundle;
import android.util.AtomicFile;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
public final class IdentityProbe extends Instrumentation {
  public void onCreate(Bundle args) { super.onCreate(args); start(); }
  public void onStart() {
    Bundle result = new Bundle();
    try {
      byte[] sealed = new AtomicFile(new File(getTargetContext().getNoBackupFilesDir(), "identity.v1.sealed")).readFully();
      KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
      SecretKey key = (SecretKey) store.getKey("opensteer-agent-phone-identity", null);
      if (key == null) throw new IllegalStateException("Existing identity key missing");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(sealed, 0, 12)));
      JSONObject identity = new JSONObject(new String(cipher.doFinal(sealed, 12, sealed.length - 12), StandardCharsets.UTF_8));
      JSONObject facts = new JSONObject();
      String[] names = {"version", "runnerId", "deploymentId", "deploymentName", "enrollmentId", "hostInstanceId", "hostUrl", "hostVerified", "lastConnectionGeneration"};
      for (String name : names) facts.put(name, identity.get(name));
      facts.put("approvalSeedPresent", identity.has("approvalKeySeed"));
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(identity.getString("runnerKeySeed").getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder(); for (byte b : hash) hex.append(String.format("%02x", b & 255));
      facts.put("runnerKeySha256", hex.toString());
      result.putString("identityFacts", facts.toString());
      finish(Activity.RESULT_OK, result);
    } catch (Exception error) {
      // Neither decrypted JSON nor cryptographic material belongs in instrumentation output.
      result.putString("identityProbeError", error.getClass().getSimpleName());
      finish(Activity.RESULT_CANCELED, result);
    }
  }
}
`;
  const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.opensteer.agentphone.identityprobe"><uses-sdk android:minSdkVersion="30" android:targetSdkVersion="36"/><application android:hasCode="true"/><instrumentation android:name="com.opensteer.agentphone.identityprobe.IdentityProbe" android:targetPackage="com.opensteer.agentphone"/></manifest>`;
  await writeFile(join(source, "IdentityProbe.java"), javaSource);
  await writeFile(join(source, "AndroidManifest.xml"), manifest);
  const androidJar = join(paths.sdk, "platforms/android-36/android.jar");
  await runCommand(join(paths.java, "bin/javac"), [
    "-source",
    "17",
    "-target",
    "17",
    "-classpath",
    androidJar,
    "-d",
    classes,
    join(source, "IdentityProbe.java"),
  ]);
  await runCommand(join(paths.tools, "d8"), [
    "--lib",
    androidJar,
    "--min-api",
    "30",
    "--output",
    dex,
    join(classes, "com/opensteer/agentphone/identityprobe/IdentityProbe.class"),
  ]);
  const unsigned = join(source, "observer-unsigned.apk");
  await runCommand(join(paths.tools, "aapt2"), [
    "link",
    "-o",
    unsigned,
    "--manifest",
    join(source, "AndroidManifest.xml"),
    "-I",
    androidJar,
  ]);
  await runCommand("zip", ["-j", unsigned, join(dex, "classes.dex")]);
  const aligned = join(source, "observer-aligned.apk");
  await runCommand(join(paths.tools, "zipalign"), ["-f", "4", unsigned, aligned]);
  const apk = join(source, "identity-observer.apk");
  await runCommand(join(paths.tools, "apksigner"), [
    "sign",
    "--ks",
    paths.key,
    "--ks-key-alias",
    "update-test",
    "--ks-pass",
    "pass:opensteer-test",
    "--key-pass",
    "pass:opensteer-test",
    "--out",
    apk,
    aligned,
  ]);
  return apk;
}
