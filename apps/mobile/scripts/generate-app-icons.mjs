/**
 * Draws the Opensteer mark at the sizes the native platforms demand.
 *
 * The mark itself is `apps/web/public/opensteer.png` — one circle filled with a
 * vertical ramp from a neutral highlight to the ember. It is redrawn here
 * rather than rescaled because the source is 512px and an iOS icon is 1024px,
 * and because the phone needs the mark composited on the product's own ground
 * (an iOS icon may not carry alpha) as well as cut out for Android's adaptive
 * foreground. The ramp endpoints below are read off that file's centre column.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const markTop = [217, 217, 217];
const markBottom = [232, 195, 184];
const ground = [8, 8, 8];
const samplesPerAxis = 4;

const outputs = [
  // The iOS application icon: opaque, mark inset so the rounded mask never
  // clips it.
  { file: "assets/icon.png", size: 1024, coverage: 0.62, opaque: true },
  // Android's adaptive foreground: the outer third is reserved for the mask's
  // travel, so the mark occupies the middle.
  { file: "assets/adaptive-icon.png", size: 1024, coverage: 0.44, opaque: false },
  // The launch screen shows the mark small on the same ground.
  { file: "assets/splash-icon.png", size: 512, coverage: 0.5, opaque: false },
  // Android's notification icon. The platform keeps only the alpha channel and
  // paints the silhouette in the tint from `app.config.ts`, so the mark is
  // drawn flat white and the ramp would be thrown away.
  { file: "assets/notification-icon.png", size: 96, coverage: 0.66, opaque: false, flat: true },
];

/** RGBA bytes for one square canvas, anti-aliased by area sampling. */
function drawMark({ size, coverage, opaque, flat }) {
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
      const markAlpha = inside / (samplesPerAxis * samplesPerAxis);
      // The ramp runs across the mark, not the canvas, so the same colours
      // land at the same points of the circle at every size.
      const ramp = Math.min(1, Math.max(0, (y - (centre - radius)) / (radius * 2)));
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const mark = flat
          ? 255
          : markTop[channel] + (markBottom[channel] - markTop[channel]) * ramp;
        pixels[offset + channel] = opaque
          ? Math.round(ground[channel] + (mark - ground[channel]) * markAlpha)
          : Math.round(mark);
      }
      pixels[offset + 3] = opaque ? 255 : Math.round(markAlpha * 255);
    }
  }
  return pixels;
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

for (const output of outputs) {
  const path = resolve(import.meta.dirname, "..", output.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(output.size, drawMark(output)));
  process.stdout.write(`${output.file} ${output.size}x${output.size}\n`);
}
