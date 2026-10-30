import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Release = { version: string; revision: string };
export async function githubJourney(c: {
  channel: "stable" | "beta";
  scenario: string;
  input: { n: Release; next: Release };
  root: string;
  share: string;
  out: string;
  app: string;
  data: string;
  bundleId: string;
  product: string;
  run: (
    exe: string,
    args: string[],
    allowFailure?: boolean,
  ) => { code: number | null; output: string };
  wait: (name: string, predicate: () => boolean, seconds?: number) => Promise<void>;
  verify: (version: string) => Promise<void>;
  health: () => boolean;
  running: () => boolean;
  plist: (key: string) => string;
  readLog: () => string;
  script: (script: string) => unknown;
  screenshot: (name: string) => void;
  observe: (child: ReturnType<typeof spawn>) => void;
  record: (name: string, output?: string) => void;
}) {
  const { channel, input, root, out, app, product } = c;
  const asset = channel === "stable" ? "Opensteer-mac-arm64.zip" : "Opensteer-Beta-mac-arm64.zip";
  const yml = channel === "stable" ? "latest-mac.yml" : "insider-mac.yml";
  const tag = (v: string, ch = channel) => (ch === "stable" ? `desktop-v${v}` : `v${v}-insider`);
  const other = channel === "stable" ? "beta" : "stable";
  const feed = (v: string) => {
    writeFileSync(
      path.join(root, "latest"),
      tag(channel === "stable" ? v : input.next.version, "stable"),
    );
    const tags = ["v0.10.2", tag(input.next.version, other), tag(v), tag(input.n.version)];
    writeFileSync(path.join(root, "atom.json"), JSON.stringify([...new Set(tags)]));
  };
  feed(input.n.version);
  const zip = path.join(c.share, tag(input.n.version), asset);
  const expected = readFileSync(path.join(c.share, tag(input.n.version), "SHA256SUMS"), "utf8")
    .split("\n")
    .find((x) => x.trim().split(/\s+/u)[1] === asset)
    ?.split(/\s+/u)[0];
  const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
  assert.equal(hash, expected);
  c.record("verified direct archive installation", hash);
  c.run("ditto", ["-x", "-k", zip, "/Applications"]);
  assert(!c.run("xattr", ["-r", app]).output.includes("com.apple.quarantine"));
  c.run("open", [app]);
  await c.verify(input.n.version);
  const marker = path.join(c.data, "public-download-marker");
  writeFileSync(marker, input.n.revision);
  const menu = () =>
    spawnSync(
      "osascript",
      [
        "-e",
        `tell application "System Events" to tell process "${product}" to get name of every menu item of menu 1 of menu bar item "${product}" of menu bar 1`,
      ],
      { encoding: "utf8" },
    ).stdout ?? "";
  const restart = async () => {
    c.script(`tell application "${product}" to quit`);
    await c.wait("app quit", () => !c.running());
    c.run("open", [app]);
    await c.wait("Personal healthy after launch", c.health);
  };
  const requests = () =>
    readFileSync(path.join(out, "network.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (x) =>
          JSON.parse(x) as {
            at: number;
            path?: string;
            host?: string;
            transferComplete?: string;
            delayedDownload?: string;
          },
      );
  const downloads = () =>
    requests().filter((x) => x.host === "objects.opensteer.test" && x.path?.endsWith(".zip"))
      .length;
  const noOffer = async (name: string) => {
    const before = c.readLog().length,
      count = downloads();
    await restart();
    await c.wait(
      `${name}: actual provider check`,
      () => c.readLog().slice(before).includes("desktop.update.not-available"),
      90,
    );
    assert.equal(downloads(), count);
    assert(!menu().includes("Restart to Update"));
    c.record(
      name,
      "Provider checked mixed Atom/Latest metadata; no zip download and no restart action",
    );
  };
  const positive = async (method: string) => {
    feed(input.next.version);
    const requireReadinessProof = c.scenario !== "eu-negative";
    if (requireReadinessProof) writeFileSync(path.join(root, "slow-download"), "");
    const before = c.readLog().length;
    await restart();
    const observations: {
      at: number;
      readyEvent: boolean;
      menu: boolean;
      downloadPending: boolean;
    }[] = [];
    await c.wait(
      "native readiness and real restart menu",
      () => {
        const visible = menu().includes("Restart to Update"),
          native = c.readLog().slice(before).includes("desktop.update.downloaded");
        assert(!visible || native, "Restart action must follow the native update-downloaded log");
        const r = requests(),
          start = r.findLast((x) => x.delayedDownload?.endsWith(asset)),
          end = r.findLast((x) => x.transferComplete?.endsWith(asset));
        observations.push({
          at: Date.now(),
          readyEvent: native,
          menu: visible,
          downloadPending: !!start && (!end || end.at < start.at),
        });
        return visible;
      },
      180,
    );
    assert(
      !requireReadinessProof ||
        observations.some((x) => x.downloadPending && !x.menu && !x.readyEvent),
      "Menu must stay absent during the delayed real download",
    );
    writeFileSync(path.join(out, "native-readiness.json"), JSON.stringify(observations, null, 2));
    c.screenshot("native-update-ready");
    const observerPath = path.join(out, "shutdown-observer.json");
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.join(import.meta.dirname, "shutdown-observer.ts"),
        app,
        input.next.version,
        observerPath,
      ],
      { stdio: "inherit" },
    );
    c.observe(child);
    const done = new Promise<number | null>((resolve) => child.once("close", resolve));
    await delay(500);
    if (method === "quit") {
      c.script(`tell application "${product}" to quit`);
      await c.wait("ordinary quit", () => !c.running());
      await c.wait(
        "ordinary quit installed N+1",
        () => existsSync(app) && c.plist("CFBundleShortVersionString") === input.next.version,
      );
      c.run("open", [app]);
    } else if (method === "tray") {
      c.script(
        `tell application "System Events" to tell process "${product}" to perform action "AXShowMenu" of menu bar item 1 of menu bar 2`,
      );
      c.script(
        `tell application "System Events" to tell process "${product}" to click menu item "Restart to Update" of menu 1 of menu bar item 1 of menu bar 2`,
      );
    } else
      c.script(
        `tell application "System Events" to tell process "${product}" to click menu item "Restart to Update" of menu 1 of menu bar item "${product}" of menu bar 1`,
      );
    await c.wait(
      "ShipIt installed N+1",
      () => existsSync(app) && c.plist("CFBundleShortVersionString") === input.next.version,
    );
    await c.verify(input.next.version);
    assert.equal(await done, 0);
    assert.equal(JSON.parse(readFileSync(observerPath, "utf8")).passed, true);
    assert.equal(readFileSync(marker, "utf8"), input.n.revision);
    c.record("marker preserved and children exited before swap");
    rmSync(path.join(root, "slow-download"), { force: true });
  };
  if (c.scenario !== "eu-negative") {
    // The feed always puts the other channel and legacy stable release ahead of ours.
    await noOffer("equal version and channel isolation");
    await positive(c.scenario === "eu-tray" ? "tray" : c.scenario === "eu-quit" ? "quit" : "menu");
    return;
  }
  await noOffer("equal version and channel isolation");
  const targetDir = path.join(root, tag(input.next.version));
  const targetZip = path.join(targetDir, asset);
  const originalYml = readFileSync(path.join(targetDir, yml));
  const metadata = (directory: string, version: string) => {
    const bytes = readFileSync(path.join(directory, asset)),
      sha512 = createHash("sha512").update(bytes).digest("base64");
    writeFileSync(
      path.join(directory, yml),
      JSON.stringify({
        version,
        files: [{ url: asset, sha512, size: bytes.length }],
        path: asset,
        sha512,
        releaseDate: new Date().toISOString(),
        releaseName: "Private negative fixture",
      }),
    );
  };
  const bad = path.join(root, "wrong-signer");
  mkdirSync(bad);
  c.run("ditto", ["-x", "-k", targetZip, bad]);
  const badApp = path.join(bad, path.basename(app));
  c.run("codesign", ["--force", "--deep", "--sign", "-", badApp]);
  c.run("codesign", ["-dv", badApp], true);
  rmSync(targetZip);
  c.run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", badApp, targetZip]);
  metadata(targetDir, input.next.version);
  feed(input.next.version);
  let before = c.readLog().length,
    count = downloads();
  await restart();
  await c.wait(
    "native rejects wrong signer",
    () => c.readLog().slice(before).includes("desktop.update.failed"),
    180,
  );
  assert(downloads() > count);
  assert(!c.readLog().slice(before).includes("desktop.update.downloaded"));
  assert(!menu().includes("Restart to Update"));
  assert.equal(c.plist("CFBundleShortVersionString"), input.n.version);
  assert(c.health());
  c.record("wrong signer refused; N healthy");
  cpSync(path.join(c.share, tag(input.next.version), asset), targetZip);
  writeFileSync(path.join(targetDir, yml), originalYml);
  await positive("menu");
  const misleading = "0.1.221",
    directory = path.join(root, tag(misleading));
  mkdirSync(directory);
  cpSync(path.join(c.share, tag(input.n.version), asset), path.join(directory, asset));
  metadata(directory, misleading);
  feed(misleading);
  before = c.readLog().length;
  count = downloads();
  await restart();
  await c.wait(
    "native rejects misleading metadata downgrade",
    () => c.readLog().slice(before).includes("desktop.update.failed"),
    180,
  );
  assert(downloads() > count);
  assert(!c.readLog().slice(before).includes("desktop.update.downloaded"));
  assert(!menu().includes("Restart to Update"));
  assert.equal(c.plist("CFBundleShortVersionString"), input.next.version);
  assert(c.health());
  assert.equal(readFileSync(marker, "utf8"), input.n.revision);
  c.record("higher YAML version carrying lower signed bundle refused; N+1 healthy");
}
