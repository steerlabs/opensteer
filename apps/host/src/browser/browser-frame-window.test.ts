import { afterEach, expect, it, vi } from "vitest";
import { BrowserConsumerOutlet } from "./browser-service.js";
import type { BrowserBinaryFrameHeader } from "@opensteer/protocol";

afterEach(() => vi.useRealTimers());

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
