import { randomUUID } from "node:crypto";
import { BrowserSurfaceIdSchema, type BrowserClientMessage } from "@opensteer/protocol";
import {
  EditingClipboardItemsSchema,
  editingClipboardMaxBytes,
  editingClipboardPartMaxBytes,
} from "@opensteer/protocol/editing";
import { expect, it } from "vitest";
import { ClipboardParts } from "./editing-clipboard.js";

type Paste = Extract<BrowserClientMessage, { type: "clipboard.paste-data" }>;

// Near-cap sizes are checked here, where reassembly is what the cap governs: a
// real browser spends CPU in proportion to the payload, so a near-cap paste
// there outlasts any fixed wait on a loaded machine.
function nearCapPaste(sizes: readonly number[]) {
  const message: Paste = {
    type: "clipboard.paste-data",
    surfaceId: BrowserSurfaceIdSchema.parse("page-1"),
    operationId: randomUUID(),
    items: sizes.map((size, index) => ({ type: index ? "text/plain" : "image/png", size })),
  };
  const bytes = Buffer.alloc(sizes.reduce((total, size) => total + size, 0));
  let n = 123456789;
  for (let index = 0; index < bytes.length; index++) {
    n ^= n << 13;
    n ^= n >>> 17;
    n ^= n << 5;
    bytes[index] = n & 255;
  }
  const send = (parts: ClipboardParts, data = bytes) => {
    for (let index = 0; index * editingClipboardPartMaxBytes < data.length; index++)
      parts.part({
        type: "clipboard.part",
        part: {
          operationId: message.operationId,
          index,
          data: data
            .subarray(
              index * editingClipboardPartMaxBytes,
              (index + 1) * editingClipboardPartMaxBytes,
            )
            .toString("base64"),
        },
      });
  };
  return { message, bytes, send };
}

it("contains a refused paste's failed outcome write and releases its bounded staging", async () => {
  const outcomes: string[] = [];
  const parts = new ClipboardParts(async (_message, outcome) => {
    outcomes.push(outcome);
    throw new Error("The controller socket closed while reporting its refusal.");
  });
  const messages: Extract<BrowserClientMessage, { type: "clipboard.paste-data" }>[] = Array.from(
    { length: 5 },
    () => ({
      type: "clipboard.paste-data",
      surfaceId: BrowserSurfaceIdSchema.parse("page-1"),
      operationId: randomUUID(),
      items: [{ type: "text/plain", size: 1 }],
    }),
  );
  try {
    for (const message of messages.slice(0, 4)) expect(parts.stage(message)).toBe(true);
    expect(parts.stage(messages[4]!)).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcomes).toEqual(["too-large"]);
  } finally {
    parts.cancel();
    await Promise.all(messages.slice(0, 4).map((message) => parts.take(message)));
  }
  expect(parts.stage(messages[4]!)).toBe(true);
  parts.cancel();
  await expect(parts.take(messages[4]!)).resolves.toBeNull();
});

it("reassembles a near-cap paste from its parts into the same bytes, item by item", async () => {
  const parts = new ClipboardParts(async () => {});
  const total = 30 * editingClipboardPartMaxBytes - 123;
  const paste = nearCapPaste([total - 1000, 1000]);
  expect(parts.stage(paste.message)).toBe(true);
  paste.send(parts);
  const items = await parts.take(paste.message);
  expect(items?.map((item) => item.type)).toEqual(["image/png", "text/plain"]);
  expect(Buffer.concat(items!.map((item) => item.bytes)).equals(paste.bytes)).toBe(true);
  expect(Buffer.from(items![1]!.bytes).equals(paste.bytes.subarray(total - 1000))).toBe(true);
});

it("accepts a paste of exactly the cap and refuses one byte more", async () => {
  expect(
    EditingClipboardItemsSchema.safeParse([{ type: "image/png", size: editingClipboardMaxBytes }])
      .success,
  ).toBe(true);
  expect(
    EditingClipboardItemsSchema.safeParse([
      { type: "image/png", size: editingClipboardMaxBytes - 1 },
      { type: "text/plain", size: 2 },
    ]).success,
  ).toBe(false);

  const parts = new ClipboardParts(async () => {});
  const exact = nearCapPaste([editingClipboardMaxBytes]);
  expect(parts.stage(exact.message)).toBe(true);
  exact.send(parts);
  const [exactItem] = (await parts.take(exact.message)) ?? [];
  expect(exactItem && Buffer.from(exactItem.bytes).equals(exact.bytes)).toBe(true);

  const outcomes: string[] = [];
  const over = new ClipboardParts(async (_message, outcome) => {
    outcomes.push(outcome);
  });
  const declared = nearCapPaste([editingClipboardMaxBytes]);
  expect(over.stage(declared.message)).toBe(true);
  const last = editingClipboardMaxBytes / editingClipboardPartMaxBytes - 1;
  declared.send(over, declared.bytes.subarray(0, last * editingClipboardPartMaxBytes));
  // The final part carries one byte more than the paste declared.
  over.part({
    type: "clipboard.part",
    part: {
      operationId: declared.message.operationId,
      index: last,
      data: Buffer.concat([
        declared.bytes.subarray(last * editingClipboardPartMaxBytes),
        Buffer.from([0]),
      ]).toString("base64"),
    },
  });
  await expect(over.take(declared.message)).resolves.toBeNull();
  expect(outcomes).toEqual(["too-large"]);
});
