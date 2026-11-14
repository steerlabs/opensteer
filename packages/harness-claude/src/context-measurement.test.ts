import { expect, it } from "vitest";
import { ClaudeContextMeasurement } from "./context-measurement.js";

it("measures main requests, merges cumulative deltas, and uses the earliest mixed TTL", () => {
  const tracker = new ClaudeContextMeasurement();
  const start = {
    type: "stream_event",
    ttft_ms: 100,
    event: {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 199_990,
          cache_creation_input_tokens: 8,
          output_tokens: 1,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 6 },
        },
      },
    },
  };
  tracker.accept(start, 1_000);
  tracker.accept(
    { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 10 } } },
    2_000,
  );
  tracker.accept({ ...start, parent_tool_use_id: "child", request_sent_wall_ms: 50 }, 3_000);
  expect(tracker.snapshot()).toEqual({
    usedTokens: 200_010,
    measuredAt: 2_000,
    requestStartedAt: 900,
    promptCacheTtlMs: 300_000,
  });
});
it("uses explicit request time, keeps unknown TTL unknown and clears on compaction", () => {
  const tracker = new ClaudeContextMeasurement();
  tracker.accept(
    {
      type: "stream_event",
      request_sent_wall_ms: 123,
      event: { type: "message_start", message: { usage: { input_tokens: 200_000 } } },
    },
    1_000,
  );
  expect(tracker.snapshot()).toMatchObject({ requestStartedAt: 123, promptCacheTtlMs: null });
  tracker.accept({ type: "system", subtype: "compact_boundary" }, 2_000);
  expect(tracker.snapshot()).toBeNull();
});
it("retains cumulative fields on null deltas and replaces zero values", () => {
  const tracker = new ClaudeContextMeasurement();
  tracker.accept(
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 200_000,
            output_tokens: 5,
            cache_creation: { ephemeral_1h_input_tokens: 10 },
          },
        },
      },
    },
    100,
  );
  tracker.accept(
    {
      type: "stream_event",
      event: { type: "message_delta", usage: { input_tokens: null, output_tokens: 0 } },
    },
    200,
  );
  tracker.accept({ type: "result", request_sent_wall_ms: 50 }, 300);
  expect(tracker.snapshot()).toEqual({
    usedTokens: 200_010,
    measuredAt: 200,
    requestStartedAt: 50,
    promptCacheTtlMs: 3_600_000,
  });
  tracker.accept(
    {
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 20 } } },
    },
    400,
  );
  expect(tracker.snapshot()).toEqual({
    usedTokens: 20,
    measuredAt: 400,
    requestStartedAt: null,
    promptCacheTtlMs: null,
  });
});
