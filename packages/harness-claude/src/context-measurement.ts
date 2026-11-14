import type { ProviderContextMeasurement } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";

export class ClaudeContextMeasurement {
  #usage: Record<string, unknown> = {};
  #snapshot: ProviderContextMeasurement | null = null;
  accept(frame: unknown, nowMs: number): void {
    if (!isRecord(frame) || frame.parent_tool_use_id) return;
    if (
      frame.type === "system" &&
      (frame.subtype === "compact_boundary" || frame.subtype === "compact_result")
    ) {
      this.#snapshot = null;
      this.#usage = {};
      return;
    }
    if (
      frame.type === "system" &&
      frame.subtype === "status" &&
      frame.compact_result === "success"
    ) {
      this.#snapshot = null;
      this.#usage = {};
      return;
    }
    if (
      frame.type === "result" &&
      this.#snapshot &&
      typeof frame.request_sent_wall_ms === "number" &&
      Number.isSafeInteger(frame.request_sent_wall_ms) &&
      frame.request_sent_wall_ms >= 0
    ) {
      this.#snapshot = { ...this.#snapshot, requestStartedAt: frame.request_sent_wall_ms };
      return;
    }
    const event = isRecord(frame.event) ? frame.event : null;
    if (frame.type !== "stream_event" || !event) return;
    const start = event.type === "message_start";
    const message = isRecord(event.message) ? event.message : {};
    const usage = start ? message.usage : event.type === "message_delta" ? event.usage : null;
    if (!isRecord(usage)) return;
    if (start) this.#usage = {};
    for (const [key, value] of Object.entries(usage)) if (value != null) this.#usage[key] = value;
    const count = (key: string) => {
      const value = this.#usage[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    const input =
      count("input_tokens") +
      count("cache_read_input_tokens") +
      count("cache_creation_input_tokens");
    if (input <= 0) return;
    const creation = isRecord(this.#usage.cache_creation) ? this.#usage.cache_creation : {};
    const promptCacheTtlMs =
      typeof creation.ephemeral_5m_input_tokens === "number" &&
      creation.ephemeral_5m_input_tokens > 0
        ? 300_000
        : typeof creation.ephemeral_1h_input_tokens === "number" &&
            creation.ephemeral_1h_input_tokens > 0
          ? 3_600_000
          : null;
    const sent = frame.request_sent_wall_ms;
    const ttft = frame.ttft_ms;
    const requestStartedAt = start
      ? typeof sent === "number" && Number.isSafeInteger(sent) && sent >= 0
        ? sent
        : typeof ttft === "number" && Number.isFinite(ttft) && ttft >= 0
          ? Math.max(0, Math.floor(nowMs - ttft))
          : null
      : (this.#snapshot?.requestStartedAt ?? null);
    this.#snapshot = {
      usedTokens: input + count("output_tokens"),
      measuredAt: nowMs,
      requestStartedAt,
      promptCacheTtlMs,
    };
  }
  snapshot(): ProviderContextMeasurement | null {
    return this.#snapshot;
  }
}
