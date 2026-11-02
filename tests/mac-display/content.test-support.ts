import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const encoded = z.array(z.object({ key: z.boolean(), codec: z.string(), data: z.string() }));
export async function content(directory: string, fps: number, seconds: number) {
  const source = join(import.meta.dirname, "generate.swift");
  const profile = z
    .enum(["baseline", "main"])
    .parse(process.env.OPENSTEER_MAC_BENCH_PROFILE ?? "baseline");
  const gop = Number(process.env.OPENSTEER_MAC_BENCH_GOP ?? 6);
  if (!Number.isSafeInteger(gop) || gop < 1 || gop > 600) throw new Error("GOP must be 1..600");
  const rates = [750_000, 1_500_000, 3_000_000, 6_000_000, 12_000_000];
  const hash = createHash("sha256")
    .update(await readFile(source))
    .update(JSON.stringify({ fps, seconds, profile, gop, rates }))
    .digest("hex")
    .slice(0, 20);
  const cache = join(directory, "content", hash);
  await mkdir(cache, { recursive: true });
  const rungs = [];
  for (const bitrate of rates) {
    // Every phase encodes identical pictures with offset IDRs. A refresh can
    // switch at the retained picture's IDR and keep a valid reference chain.
    const tracks = [];
    for (let phase = 0; phase < gop; phase++) {
      const path = join(cache, `${bitrate}-${phase}.json`);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        process.stdout.write(`Encoding ${fps}fps ${bitrate}bps ${profile}…\n`);
        await promisify(execFile)(
          "swift",
          [
            source,
            `${path}.partial`,
            String(fps),
            String(seconds),
            String(bitrate),
            profile,
            String(gop),
            String(phase),
          ],
          { timeout: 300_000, maxBuffer: 1024 * 1024 },
        );
        await rename(`${path}.partial`, path);
        raw = await readFile(path, "utf8");
      }
      tracks.push(
        encoded
          .parse(JSON.parse(raw))
          .map((frame) => ({ ...frame, payload: Buffer.from(frame.data, "base64") })),
      );
    }
    rungs.push({ bitrate, width: 1512, height: 982, tracks });
  }
  return { hash, profile, gop, rungs };
}
