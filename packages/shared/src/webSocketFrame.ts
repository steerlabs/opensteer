/** WebSocket frame payload normalization. */

/** Structurally the `ws` package's `RawData`, without depending on `ws`. */
export type WebSocketFrame = ArrayBuffer | Buffer | readonly Buffer[];

/**
 * A `ws` frame arrives as one of three shapes depending on how the peer
 * fragmented it. Every reader wants the bytes, so the fragmentation is
 * flattened once here rather than at each socket.
 */
export function rawDataBuffer(raw: WebSocketFrame): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  throw new TypeError("Unsupported WebSocket frame type");
}
