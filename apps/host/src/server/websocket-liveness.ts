import WebSocket from "ws";

interface WebSocketLivenessOptions {
  readonly intervalMs?: number;
}

const maximumTimerDelayMilliseconds = 2_147_483_647;

/** Rearms long deadlines so Node never truncates an expiry timer to one millisecond. */
export function scheduleWebSocketExpiration(expiresAt: number, onExpire: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      onExpire();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, maximumTimerDelayMilliseconds));
    timer.unref();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/** Owns RFC 6455 Ping/Pong liveness for one long-lived WebSocket. */
export function installWebSocketLiveness(
  socket: WebSocket,
  options: WebSocketLivenessOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 20_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError("WebSocket liveness interval must be a positive safe integer.");
  }

  let alive = true;
  let closed = false;
  const onPong = () => {
    alive = true;
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    socket.off("pong", onPong);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
  };
  const timer = setInterval(() => {
    if (socket.readyState === WebSocket.CONNECTING) return;
    if (socket.readyState !== WebSocket.OPEN) {
      cleanup();
      return;
    }
    if (!alive) {
      cleanup();
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, intervalMs);
  timer.unref();
  socket.on("pong", onPong);
  socket.once("close", cleanup);
  socket.once("error", cleanup);
  return cleanup;
}
