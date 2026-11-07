import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseCaptureJsonl } from "./captureJsonl.test-support.js";

it("reads only complete records while an append is in progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capture-framing-"));
  try {
    const path = join(directory, "capture.jsonl");
    const first = { fakeTurn: { pid: 1 } };
    const next = { method: "turn/start", params: { text: "x".repeat(4096) } };
    const record = JSON.stringify(next);
    await writeFile(path, `${JSON.stringify(first)}\n${record.slice(0, 1304)}`);
    expect(parseCaptureJsonl(await readFile(path, "utf8"))).toEqual([first]);
    await appendFile(path, record.slice(1304));
    expect(parseCaptureJsonl(await readFile(path, "utf8"))).toEqual([first]);
    await appendFile(path, "\n");
    expect(parseCaptureJsonl(await readFile(path, "utf8"))).toEqual([first, next]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails loudly on malformed newline-terminated records", () => {
  expect(() => parseCaptureJsonl('{"ok":true}\n{"broken":"tail\n')).toThrow(SyntaxError);
});
