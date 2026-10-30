import { writeFileSync } from "node:fs";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { BrowserConsumerOutlet } from "./browser-service.js";
import { BrowserSurfaceIdSchema, type BrowserBinaryFrameHeader } from "@opensteer/protocol";

afterEach(() => vi.useRealTimers());
const measurements: unknown[] = [];
afterAll(() => {
  const report = process.env.OPENSTEER_BROWSER_LINK_REPORT;
  if (report) writeFileSync(report, JSON.stringify(measurements, null, 2) + "\n");
});

async function simulatedLink(
  windowed: boolean,
  roundTrip: number | ((at: number) => number),
  bandwidth: number | ((at: number) => number),
  imageBytes: number,
  steadyFrom = 2_000,
) {
  vi.useFakeTimers();
  const captures = new Map<number, number>();
  const pictures: { at: number; age: number; bytes: number }[] = [];
  let linkFreeAt = performance.now();
  const outlet = new BrowserConsumerOutlet(
    {
      id: "modelled-link",
      isOpen: () => true,
      close: () => {
        throw new Error("The simulated viewer unexpectedly stalled");
      },
      send: async (data, binary) => {
        if (!binary) return;
        const bytes = Buffer.from(data);
        const header = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString()) as {
          watchToken: string;
          frameId: number;
        };
        const rtt = typeof roundTrip === "number" ? roundTrip : roundTrip(performance.now());
        const bitsPerSecond =
          typeof bandwidth === "number" ? bandwidth : bandwidth(performance.now());
        linkFreeAt =
          Math.max(linkFreeAt, performance.now()) + (bytes.byteLength * 8_000) / bitsPerSecond;
        setTimeout(
          () => {
            pictures.push({
              at: performance.now(),
              age: performance.now() - captures.get(header.frameId)!,
              bytes: bytes.byteLength,
            });
            setTimeout(() => {
              void outlet.acknowledge(header.watchToken);
            }, rtt / 2);
          },
          linkFreeAt + rtt / 2 + 16 - performance.now(),
        );
      },
    },
    "watch",
    async () => true,
    () => {},
  );
  outlet.subscription = "frames";
  outlet.frameWindow = windowed;
  let frameId = 0;
  const produce = () => {
    captures.set(++frameId, performance.now());
    const header: BrowserBinaryFrameHeader = {
      encoding: "jpeg",
      frameId,
      surfaceId: BrowserSurfaceIdSchema.parse("page"),
      geometryRevision: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      rasterWidth: 800,
      rasterHeight: 600,
    };
    const encoded = Buffer.from(JSON.stringify(header));
    const frame = Buffer.alloc(4 + encoded.length + imageBytes);
    frame.writeUInt32BE(encoded.length);
    encoded.copy(frame, 4);
    outlet.sendFrame(frame, header);
  };
  const producer = setInterval(produce, 1000 / 30);
  await vi.advanceTimersByTimeAsync(12_000);
  clearInterval(producer);
  outlet.close();
  vi.clearAllTimers();
  const steady = pictures.filter((picture) => picture.at >= steadyFrom && picture.at < 12_000);
  const ages = steady.map((picture) => picture.age).sort((a, b) => a - b);
  return {
    fps: steady.length / ((12_000 - steadyFrom) / 1000),
    p95: ages[Math.floor(ages.length * 0.95)]!,
    bytes: steady.reduce((sum, picture) => sum + picture.bytes, 0),
  };
}

it.each(
  [40, 100, 200].flatMap((rtt) =>
    [1_000_000, 10_000_000].flatMap((bps) =>
      [8_000, 100_000].map((bytes) => ({ rtt, bps, bytes })),
    ),
  ),
)(
  "bounds picture age on a $rtt ms / $bps bps link with $bytes-byte pictures",
  async ({ rtt, bps, bytes }) => {
    const legacy = await simulatedLink(false, rtt, bps, bytes);
    const windowed = await simulatedLink(true, rtt, bps, bytes);
    measurements.push({ rtt, bps, bytes, legacy, windowed });
    expect(windowed.fps).toBeGreaterThanOrEqual(legacy.fps * 0.95);
    expect(windowed.p95).toBeLessThanOrEqual(legacy.p95 + Math.max(40, legacy.p95 * 0.25));
  },
);

it("keeps legacy credit fixed and negotiates growth, exact receipts and reset", async () => {
  vi.useFakeTimers();
  const frames: Buffer[] = [];
  const outlet = new BrowserConsumerOutlet(
    {
      id: "test",
      isOpen: () => true,
      close: vi.fn(),
      send: async (data, binary) => {
        if (binary) frames.push(data as Buffer);
      },
    },
    "watch",
    async () => true,
    () => {},
  );
  outlet.subscription = "frames";
  const send = (frameId: number, bytes = 8) => {
    const frame = Buffer.alloc(bytes + 6);
    frame.writeUInt32BE(2);
    frame.write("{}", 4);
    outlet.sendFrame(frame, { frameId } as BrowserBinaryFrameHeader);
  };
  const token = (index: number) =>
    JSON.parse(frames[index]!.subarray(4, 4 + frames[index]!.readUInt32BE(0)).toString())
      .watchToken as string;
  send(1);
  await Promise.resolve();
  send(2);
  send(3);
  expect(frames).toHaveLength(1);
  await outlet.acknowledge(token(0));
  expect(frames).toHaveLength(2);
  expect(
    JSON.parse(frames[1]!.subarray(4, 4 + frames[1]!.readUInt32BE(0)).toString()).frameId,
  ).toBe(3);
  outlet.resetSubscription();
  outlet.frameWindow = true;
  send(4);
  await Promise.resolve();
  await outlet.acknowledge(token(2));
  send(5);
  await Promise.resolve();
  send(6);
  await Promise.resolve();
  send(7);
  expect(frames).toHaveLength(5);
  await outlet.acknowledge(token(2));
  expect(frames).toHaveLength(5);
  outlet.resetSubscription();
  send(8, 1024 * 1024);
  await Promise.resolve();
  send(9);
  expect(frames).toHaveLength(6);
  outlet.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers useful frame credit after moving to a higher-latency connection", async () => {
  const path = (at: number) => (at < 4_000 ? 20 : 200);
  const legacy = await simulatedLink(false, path, 10_000_000, 8_000, 8_000);
  const windowed = await simulatedLink(true, path, 10_000_000, 8_000, 8_000);
  expect(windowed.fps).toBeGreaterThan(legacy.fps * 2);
  expect(windowed.p95).toBeLessThanOrEqual(legacy.p95 + 40);
});
