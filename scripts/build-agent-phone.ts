import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, stat, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  AgentPhoneArtifactManifestSchema,
  type AgentPhoneArtifactManifest,
} from "../packages/protocol/src/android-phone.js";

import { androidBuildTools, inspectAgentPhoneApk } from "./release-agent-phone.cjs";

/**
 * Builds the Opensteer Agent Phone app (`apps/agent-phone`) and puts it where
 * its readers find it, each copy beside the manifest setup verifies it against:
 *
 * - `apps/web/public/agent-phone/`: the web app serves these same-origin, for
 *   setup in Chrome. Generated, and ignored by git.
 * - `apps/desktop/generated-resources/agent-phone/`: the desktop app bundles
 *   these and reads them with `readAgentPhoneArtifact()`.
 *
 * `--e2e-ca <pem>` builds for the end-to-end suite instead, and writes only to
 * `apps/agent-phone/build/e2e/`: the app, its manifest, and the fixture app
 * the suite operates through the phone. That app trusts a test CA compiled
 * into its debug network security configuration, so the suite can serve its
 * Host over TLS; it must never be what the web or desktop app hands a person's
 * phone, so neither of their copies is touched.
 *
 * Each destination holds `opensteer-agent-phone.apk` and `agent-phone.json`
 * (`AgentPhoneArtifactManifest`). The APK is written before the manifest that
 * names its digest, so a reader never sees a manifest for an APK not yet there.
 *
 * A debug build is signed with the local debug key. `--release` signs with the
 * key the `OPENSTEER_AGENT_PHONE_KEYSTORE*` environment variables name and
 * refuses to build without them; a release never takes a test CA.
 *
 * Needs a JDK 17 or newer and the Android SDK, found at `ANDROID_HOME`, else
 * `~/Library/Android/sdk`.
 */
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const projectDirectory = path.join(repositoryRoot, "apps/agent-phone");
const artifactName = "opensteer-agent-phone.apk";
const manifestName = "agent-phone.json";
const productDestinations = [
  path.join(repositoryRoot, "apps/web/public/agent-phone"),
  path.join(repositoryRoot, "apps/desktop/generated-resources/agent-phone"),
];
const e2eDestination = path.join(projectDirectory, "build/e2e");
const fixtureName = "agent-phone-fixture.apk";
interface BuildOptions {
  readonly e2eCa: string | undefined;
  readonly release: boolean;
  readonly output: string | undefined;
}

function buildOptions(argv: readonly string[]): BuildOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "e2e-ca": { type: "string" },
      release: { type: "boolean", default: false },
      output: { type: "string" },
    },
    strict: true,
  });
  if (values.release && values["e2e-ca"]) {
    throw new Error(
      "--e2e-ca applies to debug builds only; a release trusts the system's CAs alone.",
    );
  }
  if (values["e2e-ca"] && values.output)
    throw new Error(
      "--e2e-ca uses its isolated app and fixture destination; --output cannot override it.",
    );
  return {
    e2eCa: values["e2e-ca"] ? path.resolve(values["e2e-ca"]) : undefined,
    release: values.release,
    output: values.output ? path.resolve(values.output) : undefined,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = buildOptions(argv);
  if (options.e2eCa) await stat(options.e2eCa);
  const sdk = process.env.ANDROID_HOME ?? path.join(homedir(), "Library/Android/sdk");
  const buildTools = androidBuildTools({ ANDROID_HOME: sdk });
  const variant = options.release ? "release" : "debug";
  const properties = options.release
    ? await readFile(path.join(projectDirectory, "gradle.properties"), "utf8")
    : undefined;
  const configuredJvmArgs = properties?.match(/^org\.gradle\.jvmargs=(.+)$/mu)?.[1];
  if (options.release && !configuredJvmArgs)
    throw Error("Release Gradle JVM arguments are missing");
  // Gradle's no-daemon rule requires the launcher and build JVM arguments to
  // match; otherwise it forks a detached single-use daemon. Pin both sides,
  // including the wrapper's initial heap, rather than inheriting JVM overrides.
  // https://docs.gradle.org/current/userguide/gradle_daemon.html#sec:disabling_the_daemon
  // Module access from Gradle 9.8.1 JpmsConfiguration.forDaemonProcesses.
  // The wrapper JVM runs the build in-process, so it needs the daemon's full
  // module opens/exports for Groovy and configuration-cache serialization.
  const daemonModuleArgs = [
    "--add-opens=java.base/java.lang=ALL-UNNAMED",
    "--add-opens=java.base/java.lang.invoke=ALL-UNNAMED",
    "--add-opens=java.base/java.util=ALL-UNNAMED",
    "--add-opens=java.prefs/java.util.prefs=ALL-UNNAMED",
    "--add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED",
    "--add-exports=jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED",
    "--add-opens=java.base/java.nio.charset=ALL-UNNAMED",
    "--add-opens=java.base/java.net=ALL-UNNAMED",
    "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
    "--add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED",
    "--add-opens=java.xml/javax.xml.namespace=ALL-UNNAMED",
    "--add-opens=java.base/java.time=ALL-UNNAMED",
  ];
  const releaseJvmArgs = ["-Xms64m", configuredJvmArgs ?? "", ...daemonModuleArgs].join(" ");

  await run(
    path.join(projectDirectory, "gradlew"),
    [
      `:app:assemble${options.release ? "Release" : "Debug"}`,
      // Release preparation owns every compiler process so cancellation can
      // join the whole process group instead of leaving persistent daemons.
      ...(options.release
        ? [
            "--no-daemon",
            // The wrapper does not preload Gradle's instrumentation agent.
            // Match that state as well as heap options, or Gradle still forks.
            // https://github.com/gradle/gradle/issues/33211
            "-Dorg.gradle.internal.instrumentation.agent=false",
            `-Dorg.gradle.jvmargs=${releaseJvmArgs}`,
            "-Pkotlin.compiler.execution.strategy=in-process",
          ]
        : []),
      ...(options.e2eCa ? [":fixture:assembleDebug", `-PopensteerE2eCa=${options.e2eCa}`] : []),
    ],
    {
      ANDROID_HOME: sdk,
      ...(options.release ? { GRADLE_OPTS: releaseJvmArgs, JAVA_OPTS: "" } : {}),
    },
    "inherit",
  );
  const apk = path.join(projectDirectory, `app/build/outputs/apk/${variant}/app-${variant}.apk`);
  const manifest = AgentPhoneArtifactManifestSchema.parse(
    inspectAgentPhoneApk(apk, buildTools, options.release ? "release" : "debug"),
  );
  const destinations = options.output
    ? [options.output]
    : options.e2eCa
      ? [e2eDestination]
      : productDestinations;
  for (const destination of destinations) await place(apk, manifest, destination);
  if (options.e2eCa) {
    const fixture = path.join(e2eDestination, fixtureName);
    await copyFile(
      path.join(projectDirectory, "fixture/build/outputs/apk/debug/fixture-debug.apk"),
      `${fixture}.partial`,
    );
    await rename(`${fixture}.partial`, fixture);
  }
  process.stdout.write(
    `${JSON.stringify(manifest, null, 2)}\n` +
      `Agent Phone ${manifest.versionName} (${variant}${options.e2eCa ? ", end-to-end" : ""}) written to:\n` +
      destinations
        .map((destination) => `  ${path.relative(repositoryRoot, destination)}\n`)
        .join("") +
      (options.e2eCa
        ? `Fixture app: ${path.relative(repositoryRoot, e2eDestination)}/${fixtureName}\n`
        : ""),
  );
}

/** Writes the APK, then its manifest, each by rename so no reader sees half a file. */
async function place(
  apk: string,
  manifest: AgentPhoneArtifactManifest,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const apkTarget = path.join(destination, artifactName);
  await copyFile(apk, `${apkTarget}.partial`);
  await rename(`${apkTarget}.partial`, apkTarget);
  const manifestTarget = path.join(destination, manifestName);
  await writeFile(`${manifestTarget}.partial`, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(`${manifestTarget}.partial`, manifestTarget);
}

function run(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  output: "capture" | "inherit",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDirectory,
      env: { ...process.env, ...environment },
      stdio: output === "inherit" ? "inherit" : ["ignore", "pipe", "inherit"],
    });
    let captured = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      captured += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(captured);
      else reject(new Error(`${path.basename(command)} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
