import { describe, expect, it } from "vitest";
import type { LiveItem } from "@opensteer/core";
import { LiveProgressBuffer } from "./live-progress.js";

/*
 * Ways a Run's live buffer can fail its reader or its Runner:
 * - a blocked connection lets queued progress grow without bound;
 * - text dropped under backpressure leaves the reader drawing a stream with a
 *   hole in it, with nothing to tell it so or to repair it.
 */
describe("Run live progress under backpressure", () => {
  it("bounds what waits behind a blocked send and repairs the stream when sending resumes", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: LiveItem[][] = [];
    let first = true;
    const buffer = new LiveProgressBuffer({
      flushIntervalMs: 1,
      maxInFlightBytes: 64 * 1_024,
      maxPendingBytes: 4 * 1_024,
      maxSentBytes: 1_024 * 1_024 * 1_024,
      send: async (items) => {
        sent.push([...items]);
        if (first) {
          first = false;
          await blocked;
        }
      },
    });

    const chunk = "x".repeat(1_024);
    let total = "";
    for (let index = 0; index < 8_192; index += 1) {
      buffer.append({ stream: "assistant" }, chunk);
      total += chunk;
      if (index % 64 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await buffer.flush();
    // Eight MiB arrived while the first send was stuck. Whatever was queued
    // behind it is what is sent once it resumes, so that must stay bounded:
    // the rest of the stream travels as one replacement of its tail.
    const appendedBytes = sent
      .flat()
      .filter((item) => item.op === "append")
      .reduce((bytes, item) => bytes + item.text.length, 0);
    expect(appendedBytes).toBeLessThanOrEqual(256 * 1_024);
    const last = sent.flat().at(-1);
    expect(last).toMatchObject({ length: total.length, op: "replace", stream: "assistant" });
    expect(last?.text).toBe(total.slice(total.length - last!.text.length));
  });
});
