const assert = require("node:assert/strict");
const { test } = require("node:test");
const addon = require("../../generated-native/passkeys/opensteer-passkeys.node");

test("unentitled process is unavailable and cannot start a ceremony", async () => {
  assert.equal(addon.available(), false);
  assert.equal(typeof addon.capabilities().securityKeys, "boolean");
  let replies = 0;
  await new Promise((resolve, reject) =>
    addon.start("{}", (reply) => {
      try {
        assert.deepEqual(JSON.parse(reply), {
          kind: "error",
          domain: "OpensteerPasskeys",
          code: 3,
        });
        replies++;
        resolve();
      } catch (error) {
        reject(error);
      }
    }),
  );
  addon.cancel("absent");
  addon.cancel("absent");
  assert.equal(replies, 1);
});

test("native handle boundary rejects the wrong size and accepts a null handle", () => {
  assert.equal(addon.windowNumber(Buffer.alloc(8)), 0);
  assert.throws(() => addon.windowNumber(Buffer.alloc(4)), TypeError);
  assert.throws(() => addon.start({}, () => {}), TypeError);
});

test("packaging unpacks the universal addon and verifies its nested signature", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join, resolve } = require("node:path");
  const asar = require("@electron/asar");
  const { verifyPasskeyAddon } = require("../../scripts/passkeys-signing.cjs");
  const root = mkdtempSync(join(tmpdir(), "passkeys-packaging-"));
  try {
    const source = join(root, "source");
    const stage = join(source, "dist/passkeys");
    mkdirSync(stage, { recursive: true });
    copyFileSync(
      resolve(__dirname, "../../generated-native/passkeys/opensteer-passkeys.node"),
      join(stage, "opensteer-passkeys.node"),
    );
    const app = join(root, "Example.app");
    const resources = join(app, "Contents/Resources");
    mkdirSync(resources, { recursive: true });
    const archive = join(resources, "app.asar");
    const unpack = require("yaml")
      .parse(readFileSync(resolve(__dirname, "../../electron-builder.base.yml"), "utf8"))
      .asarUnpack.find((pattern) => pattern.includes("passkeys"));
    assert.equal(typeof unpack, "string");
    await asar.createPackageWithOptions(source, archive, { unpack });
    assert.equal(asar.statFile(archive, "dist/passkeys/opensteer-passkeys.node").unpacked, true);
    verifyPasskeyAddon(app, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("signing gates reject capability inheritance and an unprovisioned main capability", () => {
  const { execFileSync } = require("node:child_process");
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const {
    verifyNoInheritedPasskeyCapability,
    verifyPasskeySignature,
  } = require("../../scripts/passkeys-signing.cjs");
  const root = mkdtempSync(join(tmpdir(), "passkeys-signature-"));
  const fixture = (app) => {
    const contents = join(app, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    copyFileSync("/usr/bin/true", join(contents, "MacOS/fixture"));
    writeFileSync(
      join(contents, "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
  };
  const sign = (app, entitlements) =>
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        ...(entitlements ? ["--entitlements", entitlements] : []),
        app,
      ],
      { timeout: 30_000, stdio: "pipe" },
    );
  try {
    const app = join(root, "Example.app");
    fixture(app);
    sign(app);
    const identity = { channel: "stable", bundleId: "com.example.fixture", teamId: "ABCDE12345" };
    assert.equal(verifyPasskeySignature(app, identity, {}), false);
    const entitlements = join(root, "capability.plist");
    writeFileSync(
      entitlements,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.developer.web-browser.public-key-credential</key><true/></dict></plist>',
    );
    sign(app, entitlements);
    assert.throws(() => verifyPasskeySignature(app, identity, {}), /unprovisioned/);
    const helper = join(app, "Contents/Frameworks/Example Helper.app");
    fixture(helper);
    sign(helper, entitlements);
    assert.throws(() => verifyNoInheritedPasskeyCapability(app), /helper inherited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
