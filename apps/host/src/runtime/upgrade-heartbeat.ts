const upgradeHeartbeatMs = 15_000;

export async function withUpgradeHeartbeat<T>(
  work: () => Promise<T>,
  heartbeat: (() => void) | undefined,
): Promise<T> {
  const timer = heartbeat && setInterval(heartbeat, upgradeHeartbeatMs);
  timer?.unref();
  try {
    return await work();
  } finally {
    if (timer) clearInterval(timer);
  }
}
