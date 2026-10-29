import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { zipSync } from "fflate";
import lockfile from "proper-lockfile";
import { opensteerChromeExtensionId } from "@opensteer/protocol/browser-sources";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "dist");
const require = createRequire(import.meta.url);

/** Chrome derives an unpacked extension's ID from the SHA-256 of its public key. */
function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  return Array.from(digest.slice(0, 32), (digit) => digit)
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

// ---- The Opensteer mark ----
// apps/mobile/scripts/generate-app-icons.mjs draws the same orb for the phone:
// one circle filled with a vertical ramp from a neutral highlight to the ember.
// Here it sits on a transparent ground at Chrome's icon sizes.
const markTop = [217, 217, 217];
const markBottom = [232, 195, 184];
const samplesPerAxis = 4;

function drawMark(size, coverage) {
  const pixels = new Uint8Array(size * size * 4);
  const radius = (size * coverage) / 2;
  const centre = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      for (let sy = 0; sy < samplesPerAxis; sy += 1) {
        for (let sx = 0; sx < samplesPerAxis; sx += 1) {
          const px = x + (sx + 0.5) / samplesPerAxis - centre;
          const py = y + (sy + 0.5) / samplesPerAxis - centre;
          if (px * px + py * py <= radius * radius) inside += 1;
        }
      }
      const ramp = Math.min(1, Math.max(0, (y - (centre - radius)) / (radius * 2)));
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          markTop[channel] + (markBottom[channel] - markTop[channel]) * ramp,
        );
      }
      pixels[offset + 3] = Math.round((inside / (samplesPerAxis * samplesPerAxis)) * 255);
    }
  }
  return pixels;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function markPng(size, coverage) {
  const pixels = drawMark(size, coverage);
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

// Chrome's guidance keeps a 128px icon's artwork inside 96px; the toolbar
// sizes fill almost the whole square so the mark reads at 16px.
const icons = [
  ["icons/icon-16.png", 16, 0.9],
  ["icons/icon-32.png", 32, 0.88],
  ["icons/icon-48.png", 48, 0.8],
  ["icons/icon-128.png", 128, 0.75],
  // Web pages load this to learn the extension is installed.
  ["icons/probe.png", 48, 0.8],
  // The mark drawn inside pages, at 2x for a 44px display size.
  ["icons/mark.png", 88, 1],
];

const fonts = [
  ["fonts/inter.woff2", "@fontsource-variable/inter", "files/inter-latin-wght-normal.woff2"],
  [
    "fonts/fraunces.woff2",
    "@fontsource-variable/fraunces",
    "files/fraunces-latin-wght-normal.woff2",
  ],
  ["fonts/LICENSE-inter.txt", "@fontsource-variable/inter", "LICENSE"],
  ["fonts/LICENSE-fraunces.txt", "@fontsource-variable/fraunces", "LICENSE"],
];

const installText = `Opensteer for Chrome

1. Unzip this file into a folder you'll keep. Chrome loads the folder, not the ZIP.
2. In Chrome, open chrome://extensions.
3. Turn on Developer mode (top right).
4. Choose Load unpacked and select the unzipped folder.
5. In Opensteer, open Settings > Chrome and choose Connect Chrome.

Opensteer uses your sign-in for a website only after you allow that site in
Opensteer. Chrome shows a notification each time a new site is shared, and the
Opensteer button in Chrome's toolbar lists every shared site with Stop sharing.

To update, replace the folder's contents with a newer ZIP and choose Reload on
Opensteer in chrome://extensions.
`;

const releaseBuildLock = await lockfile.lock(root, {
  retries: { retries: 120, minTimeout: 100, maxTimeout: 100 },
  stale: 10_000,
  update: 5_000,
});
let staging;
try {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(".browser-extension-stage-")) {
      await rm(path.join(root, entry.name), { force: true, recursive: true });
    }
  }
  staging = await mkdtemp(path.join(root, ".browser-extension-stage-"));

  const manifest = JSON.parse(await readFile(path.join(root, "src/manifest.json"), "utf8"));
  const derivedId = extensionIdFromKey(manifest.key);
  if (derivedId !== opensteerChromeExtensionId) {
    throw new Error(
      `The manifest key derives extension ID ${derivedId}, but Opensteer expects ${opensteerChromeExtensionId}. Web pages find the extension by that ID.`,
    );
  }
  const releasePackage = JSON.parse(
    await readFile(path.resolve(root, "../../package.json"), "utf8"),
  );
  if (
    typeof releasePackage.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(releasePackage.version)
  ) {
    throw new Error("The release version is not a Chrome extension version.");
  }
  manifest.version = releasePackage.version;

  await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: {
      connect: "src/connect.ts",
      popup: "src/popup.ts",
      worker: "src/worker.ts",
    },
    format: "esm",
    legalComments: "none",
    minify: true,
    outdir: staging,
    platform: "browser",
    target: "chrome130",
  });
  for (const filename of ["connect.html", "connect.css", "popup.html", "popup.css", "ui.css"]) {
    await cp(path.join(root, "src", filename), path.join(staging, filename));
  }
  await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(staging, "INSTALL.txt"), installText);
  await mkdir(path.join(staging, "icons"));
  for (const [file, size, coverage] of icons) {
    await writeFile(path.join(staging, file), markPng(size, coverage));
  }
  await mkdir(path.join(staging, "fonts"));
  for (const [file, pkg, source] of fonts) {
    const packageDirectory = path.dirname(require.resolve(pkg));
    await cp(path.join(packageDirectory, source), path.join(staging, file));
  }

  const files = [];
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  await walk(staging, "");
  files.sort();
  const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");
  const archive = {};
  for (const file of files) {
    archive[file] = [await readFile(path.join(staging, file)), { mtime: fixedTimestamp }];
  }
  const webPublic = path.resolve(root, "../web/public");
  await mkdir(webPublic, { recursive: true });
  const zipPath = path.join(webPublic, "browser-extension.zip");
  const stagedZip = `${zipPath}.${process.pid}.tmp`;
  try {
    await writeFile(stagedZip, zipSync(archive, { level: 6 }));
    await rename(stagedZip, zipPath);
  } finally {
    await rm(stagedZip, { force: true });
  }
  await rm(output, { force: true, recursive: true });
  await rename(staging, output);
} finally {
  if (staging) await rm(staging, { force: true, recursive: true });
  await releaseBuildLock();
}
