import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  advertisedVersion,
  deliveryEvidence,
  rejectionEvidence,
  shutdownEvidence,
  updateFailures,
} from "./evidence.js";

type Release = { version: string; revision: string };
export async function githubJourney(c: {
  channel: "stable" | "beta";
  scenario: string;
  input: { older: Release; n: Release; next: Release };
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
  installed: (sha256: string) => void;
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
  const verifiedArchive = (release: Release) => {
    const zip = path.join(c.share, tag(release.version), asset);
    const expected = readFileSync(path.join(c.share, tag(release.version), "SHA256SUMS"), "utf8")
      .split("\n")
      .find((x) => x.trim().split(/\s+/u)[1] === asset)
      ?.split(/\s+/u)[0];
    const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
    assert.equal(
      hash,
      z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(expected),
    );
    c.record(`verified archive ${release.version}`, hash);
    return zip;
  };
  const zip = verifiedArchive(input.n);
  c.run("ditto", ["-x", "-k", zip, "/Applications"]);
  c.installed(createHash("sha256").update(readFileSync(zip)).digest("hex"));
  assert(!c.run("xattr", ["-r", app]).output.includes("com.apple.quarantine"));
  c.run("open", ["-n", app]);
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
    c.run("open", ["-n", app]);
    await c.wait("Personal healthy after launch", c.health);
  };
  const requests = () =>
    readFileSync(path.join(out, "network.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        z
          .object({
            at: z.number(),
            path: z.string().optional(),
            host: z.string().optional(),
            transferComplete: z.string().optional(),
            bytes: z.number().optional(),
            size: z.number().optional(),
            start: z.number().optional(),
            end: z.number().optional(),
          })
          .parse(JSON.parse(line)),
      );
  const downloads = () =>
    requests().filter(
      (x) => x.host === "release-assets.githubusercontent.com" && x.path?.endsWith(".zip"),
    ).length;
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
  const positive = async (method: string, label = c.scenario) => {
    feed(input.next.version);
    await restart();
    await c.wait("real restart menu available", () => menu().includes("Restart to Update"), 180);
    c.record(
      "restart action available; native event-source contract is covered by the updater unit test",
    );
    c.screenshot(`${label}-update-ready`);
    const observerPath = path.join(out, `${label}-shutdown-observer.json`);
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
    await c.wait(
      "shutdown observer ready",
      () => {
        assert(child.exitCode === null, "Shutdown observer exited before readiness");
        const ready = `${observerPath}.ready.json`;
        return (
          existsSync(ready) &&
          z.object({ ready: z.literal(true) }).parse(JSON.parse(readFileSync(ready, "utf8"))).ready
        );
      },
      20,
    );
    if (method === "quit") {
      c.script(`tell application "${product}" to quit`);
      await c.wait("ordinary quit", () => !c.running());
      await c.wait(
        "ordinary quit installed N+1",
        () => existsSync(app) && c.plist("CFBundleShortVersionString") === input.next.version,
      );
      c.run("open", ["-n", app]);
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
    const shutdown = JSON.parse(readFileSync(observerPath, "utf8"));
    assert.equal(shutdown.passed, true);
    shutdownEvidence.parse(shutdown);
    assert.equal(readFileSync(marker, "utf8"), input.n.revision);
    c.record("marker preserved and children exited before swap");
  };
  if (c.scenario !== "eu-menu") {
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
  const bad = mkdtempSync(path.join(root, "wrong-signer-"));
  c.run("ditto", ["-x", "-k", targetZip, bad]);
  const badApp = path.join(bad, path.basename(app));
  c.run("codesign", ["--force", "--deep", "--sign", "-", badApp]);
  c.run("codesign", ["-dv", badApp], true);
  rmSync(targetZip);
  c.run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", badApp, targetZip]);
  metadata(targetDir, input.next.version);
  feed(input.next.version);
  const rejection = async (
    kind: "signature" | "downgrade",
    deliveredPath: string,
    bytes: number,
  ) => {
    const started = Date.now();
    const before = c.readLog().length;
    await restart();
    await c.wait(
      `native rejects ${kind}`,
      () => updateFailures(c.readLog().slice(before)).some((f) => f.reason === kind),
      180,
    );
    const delivery = requests()
      .filter((x) => x.at >= started && x.transferComplete === deliveredPath)
      .findLast((x) => deliveryEvidence.safeParse(x).success);
    const failure = updateFailures(c.readLog().slice(before)).find(
      (f) => f.reason === kind && delivery && f.at >= delivery.at,
    );
    const evidence = rejectionEvidence.parse({ kind, delivery, expectedBytes: bytes, failure });
    writeFileSync(path.join(out, `rejection-${kind}.json`), JSON.stringify(evidence, null, 2));
    return before;
  };
  let before = await rejection(
    "signature",
    `/${tag(input.next.version)}/${asset}`,
    readFileSync(targetZip).length,
  );
  assert(!c.readLog().slice(before).includes("desktop.update.downloaded"));
  assert(!menu().includes("Restart to Update"));
  assert.equal(c.plist("CFBundleShortVersionString"), input.n.version);
  assert(c.health());
  c.record("wrong signer refused; N healthy");
  cpSync(path.join(c.share, tag(input.next.version), asset), targetZip);
  writeFileSync(path.join(targetDir, yml), originalYml);
  assert.equal(readFileSync(marker, "utf8"), input.n.revision);
  const misleading = advertisedVersion(input.n.version, input.next.version),
    directory = mkdtempSync(path.join(root, "downgrade-"));
  symlinkSync(directory, path.join(root, tag(misleading)), "dir");
  cpSync(verifiedArchive(input.older), path.join(directory, asset));
  metadata(directory, misleading);
  feed(misleading);
  before = await rejection(
    "downgrade",
    `/${tag(misleading)}/${asset}`,
    readFileSync(path.join(directory, asset)).length,
  );
  assert(!c.readLog().slice(before).includes("desktop.update.downloaded"));
  assert(!menu().includes("Restart to Update"));
  assert.equal(c.plist("CFBundleShortVersionString"), input.n.version);
  assert(c.health());
  assert.equal(readFileSync(marker, "utf8"), input.n.revision);
  c.record("higher YAML version carrying older signed bundle refused; N healthy and marker intact");
  await positive("menu", "after-both-refusals");
}
