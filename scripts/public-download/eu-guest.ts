import assert from "node:assert/strict";
import { journeyMetadata, journeyInput } from "./evidence.js";
import { forbiddenPublicUpdateHosts } from "./update-traffic.js";
import { githubJourney } from "./eu-journey.js";
import { personalEndpoint } from "./personal-endpoint.js";
import { captureTraffic } from "./traffic.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const share = "/Volumes/My Shared Files/inputs";
assert(existsSync(share), "Run only through pnpm test:vm -- --inputs DIR");
const metadata = journeyMetadata.parse(JSON.parse(process.argv[4]!));
const githubChannel = z.enum(["stable", "beta"]).parse(process.argv[3]);
const product = githubChannel === "beta" ? "Opensteer Beta" : "Opensteer";
// Electron keeps the durable runtime name used by existing profiles.
const runtimeName = product.replace(/^Opensteer/u, `Open${"S"}teer`);
const bundleId =
  githubChannel === "beta" ? "com.steerlabs.opensteer.beta" : "com.opensteer.opensteer";
process.env.OPENSTEER_JOURNEY_BUNDLE_ID = bundleId;
const scenario = z.enum(["eu-menu", "eu-tray", "eu-quit"]).parse(process.argv[2]);
const input = journeyInput.parse(JSON.parse(readFileSync(path.join(share, "input.json"), "utf8")));
const out = path.join(homedir(), "opensteer-job/artifacts/public-download");
const root = path.join(homedir(), "public-download-mirror");
mkdirSync(out, { recursive: true });
cpSync(share, root, { recursive: true });
const steps: { name: string; seconds: number; output?: string; passed: boolean }[] = [];
const log = path.join(out, "network.jsonl");
writeFileSync(log, "");
const run = (exe: string, args: string[], allowFailure = false) => {
  const started = Date.now();
  const result = spawnSync(exe, args, { encoding: "utf8", timeout: 120_000 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  steps.push({
    name: [exe, ...args].join(" "),
    seconds: (Date.now() - started) / 1000,
    output,
    passed: result.status === 0,
  });
  if (!allowFailure) assert.equal(result.status, 0, output);
  return { code: result.status, output };
};
const sh = (s: string) => run("/bin/bash", ["-c", s]);
const script = (s: string) => run("/usr/bin/osascript", ["-e", s]);

const app = `/Applications/${product}.app`;
const data = path.join(homedir(), `Library/Application Support/${runtimeName}`);
const appLog = path.join(data, "logs/desktop.log");
const readLog = () => (existsSync(appLog) ? readFileSync(appLog, "utf8") : "");
const wait = async (name: string, predicate: () => boolean, seconds = 120) => {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    if (predicate()) {
      steps.push({ name, seconds: (Date.now() - start) / 1000, passed: true });
      return;
    }
    await delay(1000);
  }
  steps.push({ name, seconds, passed: false });
  throw new Error(`Timed out: ${name}`);
};
const plist = (key: string, target = app) =>
  run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    `${target}/Contents/Info.plist`,
  ]).output.trim();
const running = (target = app) =>
  spawnSync("pgrep", ["-f", `${target}/Contents/MacOS/${product}`]).status === 0;
const health = () => {
  const r = spawnSync(
    "curl",
    [
      "-fsS",
      "--max-time",
      "2",
      `${personalEndpoint(data)?.origin ?? "http://127.0.0.1:1"}/healthz`,
    ],
    {
      encoding: "utf8",
    },
  );
  try {
    return r.status === 0 && JSON.parse(r.stdout).ok === true;
  } catch {
    return false;
  }
};
const screenshot = (name: string) => {
  // Capture the owned app window rather than the guest's unrelated desktop.
  const id = String(JSON.parse(run(path.join(out, "ax-driver"), ["window"]).output).id);
  run("/usr/sbin/screencapture", ["-x", "-l", id, path.join(out, `${name}.png`)]);
};
const verify = async (version: string, target = app) => {
  if (!health()) {
    await wait("app running", () => running(target), 30);
    run("pnpm", ["exec", "tsx", path.join(import.meta.dirname, "ui-smoke.ts"), out]);
  }
  assert.equal(plist("CFBundleShortVersionString", target), version);
  assert.equal(plist("CFBundleVersion", target), version);
  assert.equal(
    plist("OpensteerUpdateFeed", target),
    `https://github.opensteer.test/steerlabs/opensteer#${githubChannel === "stable" ? "latest" : "insider"}`,
  );
  assert.equal(plist("ElectronSquirrelPreventDowngrades", target), "true");
  const policy = readFileSync(path.join(target, "Contents/Resources/app-update.yml"), "utf8");
  assert(
    policy.includes(githubChannel === "stable" ? "opensteer-updater" : "opensteer-beta-updater"),
  );
  assert(policy.includes("github.opensteer.test"));
  assert.equal(
    plist("OpensteerSourceRevision", target),
    version === input.n.version ? input.n.revision : input.next.revision,
  );
  run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=anchor apple generic and identifier "${bundleId}" and certificate leaf[subject.OU] = "${metadata.expectedTeamId}"`,
    target,
  ]);
  run("xcrun", ["stapler", "validate", target]);
  await wait("Personal healthy", health);
  run("curl", [
    "-fsS",
    "--max-time",
    "5",
    `${personalEndpoint(data)?.origin ?? "http://127.0.0.1:1"}/healthz`,
  ]);
  run("ps", ["-axo", "pid=,command="]);
  screenshot(version);
  about(version);
};
const about = (version: string) => {
  script(`tell application "${product}" to activate`);
  script(
    `tell application "System Events" to tell process "${product}" to click menu item "About ${runtimeName}" of menu 1 of menu bar item "${product}" of menu bar 1`,
  );
  const content = run(path.join(out, "ax-driver"), ["dump"]).output;
  assert(content.includes(githubChannel === "beta" ? version : `${version} (Alpha)`), content);
  screenshot(`about-${version}`);
  script(
    `tell application "System Events" to tell process "${product}" to keystroke "w" using command down`,
  );
};
let mirror: ReturnType<typeof spawn> | undefined;
let updateObserver: ReturnType<typeof spawn> | undefined;
let error: string | undefined;
let finishCapture: Awaited<ReturnType<typeof captureTraffic>> | undefined;
let trafficSince = 0;
try {
  run("csrutil", ["status"]);
  run("sudo", ["spctl", "--global-enable"]);
  assert.match(run("spctl", ["--status"]).output, /assessments enabled/iu);
  run("swiftc", [
    path.join(import.meta.dirname, "ax-driver.swift"),
    "-o",
    path.join(out, "ax-driver"),
  ]);
  sh(
    "echo '127.0.0.1 github.opensteer.test objects.opensteer.test' | sudo tee -a /etc/hosts; sudo mkdir -p /etc/resolver; printf 'nameserver 127.0.0.1\n' | sudo tee /etc/resolver/opensteer.com",
  );
  const cert = path.join(root, "cert.pem"),
    key = path.join(root, "key.pem");
  const opensslConfig = path.join(root, "openssl.cnf");
  writeFileSync(
    opensslConfig,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Opensteer private journey CA\n[ext]\nsubjectAltName=DNS:github.opensteer.test,DNS:objects.opensteer.test\nbasicConstraints=critical,CA:TRUE\n",
  );
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-config",
    opensslConfig,
  ]);
  run("sudo", [
    "security",
    "add-trusted-cert",
    "-d",
    "-r",
    "trustRoot",
    "-k",
    "/Library/Keychains/System.keychain",
    cert,
  ]);
  for (const release of [input.n, input.next]) {
    const metadata = JSON.parse(
      readFileSync(
        path.join(
          root,
          `${githubChannel === "beta" ? `v${release.version}-insider` : `desktop-v${release.version}`}/release.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(
      metadata.title,
      githubChannel === "beta"
        ? `Opensteer Beta ${release.version}`
        : `Opensteer ${release.version} (Alpha)`,
    );
  }
  writeFileSync(path.join(root, "latest"), `desktop-v${input.n.version}`);
  run("sudo", ["ifconfig", "lo0", "alias", "127.0.0.2"]);
  mirror = spawn(
    "sudo",
    [
      process.execPath,
      "--import",
      import.meta.resolve("tsx"),
      path.join(import.meta.dirname, "eu-mirror.ts"),
      root,
      cert,
      key,
      log,
    ],
    { stdio: "inherit" },
  );
  await wait(
    "HTTPS mirror ready",
    () =>
      spawnSync("curl", [
        "-fsSL",
        "https://github.opensteer.test/api/v3/repos/steerlabs/opensteer/releases/latest",
      ]).status === 0,
    20,
  );
  for (const name of [
    "accounts.opensteer.com",
    "accounts.beta.opensteer.com",
    "portal.opensteer.com",
  ])
    sh(`echo '127.0.0.2 ${name}' | sudo tee -a /etc/hosts`);
  finishCapture = await captureTraffic(out);
  run("dig", ["@127.0.0.1", "positive-control.opensteer.com"], true);
  run("curl", ["-sS", "--max-time", "5", "http://accounts.opensteer.com/positive-control"], true);
  run("curl", ["-ksS", "--max-time", "5", "https://accounts.opensteer.com/positive-control"], true);
  await delay(1000);
  const controlLog = readFileSync(log, "utf8");
  assert(
    controlLog.includes('"forbiddenDns":') &&
      controlLog.includes('"httpHost":"accounts.opensteer.com"') &&
      controlLog.includes('"tlsSni":"accounts.opensteer.com"'),
    "Sinkhole positive controls",
  );
  writeFileSync(path.join(out, "positive-control.jsonl"), controlLog);
  writeFileSync(log, "");
  trafficSince = Date.now() / 1000;
  await githubJourney({
    channel: githubChannel,
    scenario,
    input,
    root,
    share,
    out,
    app,
    data,
    bundleId,
    product,
    run,
    wait,
    verify,
    health,
    running,
    plist,
    readLog,
    script,
    screenshot,
    observe: (child) => {
      updateObserver = child;
    },
    record: (name, output) => steps.push({ name, output, seconds: 0, passed: true }),
  });
  await delay(60_000);
} catch (e) {
  error = e instanceof Error ? e.stack : String(e);
  process.exitCode = 1;
} finally {
  if (updateObserver && updateObserver.exitCode === null && updateObserver.signalCode === null) {
    const done = new Promise<void>((resolve) => updateObserver!.once("close", () => resolve()));
    updateObserver.kill("SIGTERM");
    await done;
  }
  if (running()) run("osascript", ["-e", `tell application "${product}" to quit`], true);
  if (mirror?.pid) {
    run("sudo", ["pkill", "-TERM", "-P", String(mirror.pid)], true);
    mirror.kill("SIGTERM");
    if (mirror.exitCode === null && mirror.signalCode === null)
      await new Promise<void>((resolve) => mirror!.once("close", () => resolve()));
  }
  const shipIt = path.join(homedir(), `Library/Caches/${bundleId}.ShipIt`);
  for (const name of ["ShipIt_stderr.log", "ShipIt_stdout.log", "ShipItState.plist"]) {
    if (existsSync(path.join(shipIt, name))) cpSync(path.join(shipIt, name), path.join(out, name));
  }
  const network = readFileSync(log, "utf8");
  let packetPassed = false;
  let publicUpdateHostsAbsent = false;
  let accountHostRequests: string[] = [];
  let trafficError: string | undefined;
  try {
    const result = await finishCapture?.(trafficSince);
    packetPassed = !!result && (githubChannel === "beta" || result.forbidden.length === 0);
    accountHostRequests = result?.forbidden ?? [];
    if (result) {
      const outside = forbiddenPublicUpdateHosts(
        result.records,
        trafficSince,
        githubChannel === "beta",
      );
      const updatePolicy = readFileSync(
        path.join(app, "Contents/Resources/app-update.yml"),
        "utf8",
      );
      publicUpdateHostsAbsent =
        outside.length === 0 && updatePolicy.includes("github.opensteer.test");
      writeFileSync(
        path.join(out, "update-traffic.json"),
        JSON.stringify(
          {
            passed: publicUpdateHostsAbsent,
            forbiddenPublicUpdateHosts: outside,
            claim:
              "Guest-wide capture excludes named public GitHub/Opensteer update hosts; it does not attribute arbitrary destinations to the updater or enforce a destination allowlist.",
            permittedBetaAccountHosts:
              githubChannel === "beta"
                ? ["accounts.beta.opensteer.com", "beta.opensteer.com", "portal.beta.opensteer.com"]
                : [],
            mirrorHosts: ["github.opensteer.test", "objects.opensteer.test"],
            providerConfiguration: updatePolicy,
            mirrorRequests: network
              .split("\n")
              .filter((x) => /releases|\.zip|\.yml|blockmap/iu.test(x)),
            betaAccountTrafficInformational: githubChannel === "beta",
          },
          null,
          2,
        ),
      );
    }
  } catch (e) {
    trafficError = String(e);
    error ??= trafficError;
  }
  const noAccountTraffic =
    packetPassed &&
    !network.includes('"forbiddenDns":') &&
    !network.includes('"sinkholeConnection":true') &&
    !/"(?:httpHost|tlsSni)":"[^" ]*opensteer\.com"/iu.test(network);
  if ((githubChannel !== "beta" && !noAccountTraffic) || !publicUpdateHostsAbsent)
    process.exitCode = 1;
  writeFileSync(path.join(out, "desktop.log"), readLog());
  writeFileSync(
    path.join(out, "journey.json"),
    JSON.stringify(
      {
        scenario,
        channel: githubChannel,
        publicUpdateHostsAbsent,
        trafficError,
        accountHostRequests,
        noAccountTrafficRequired: githubChannel !== "beta",
        scope: "desktop-update",
        input,
        metadata,
        steps,
        error,
        noAccountTraffic,
        passed: !error && (githubChannel === "beta" || noAccountTraffic) && publicUpdateHostsAbsent,
        updaterEvents: readLog()
          .split("\n")
          .filter((x) => /updat|ShipIt/iu.test(x)),
      },
      null,
      2,
    ),
  );
}
