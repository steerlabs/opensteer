// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/mcp/src/sdk/connection-pool.ts (MIT).
export interface PoolConnection {
  readonly close: () => Promise<void>;
}

interface IdleConnection<T extends PoolConnection> {
  readonly connection: T;
  readonly idleSince: number;
}

export class McpConnectionPool<T extends PoolConnection> {
  readonly #idle = new Map<string, IdleConnection<T>>();
  readonly #idleTtlMs: number;

  constructor(idleTtlMs = 5 * 60_000) {
    this.#idleTtlMs = idleTtlMs;
  }

  async #acquire(
    key: string,
    connect: () => Promise<T>,
    forceFresh: boolean,
  ): Promise<{ connection: T; reused: boolean }> {
    if (!forceFresh) {
      const entry = this.#idle.get(key);
      this.#idle.delete(key);
      if (entry && Date.now() - entry.idleSince < this.#idleTtlMs)
        return { connection: entry.connection, reused: true };
      if (entry) await entry.connection.close().catch(() => undefined);
    }
    return { connection: await connect(), reused: false };
  }

  async #release(key: string, connection: T, drop: boolean): Promise<void> {
    if (drop || this.#idle.has(key)) {
      await connection.close().catch(() => undefined);
      return;
    }
    this.#idle.set(key, { connection, idleSince: Date.now() });
  }

  async withConnection<R>(
    key: string,
    connect: () => Promise<T>,
    use: (connection: T) => Promise<R>,
  ): Promise<R> {
    let lease = await this.#acquire(key, connect, false);
    try {
      const result = await use(lease.connection);
      await this.#release(key, lease.connection, false);
      return result;
    } catch (cause) {
      const status = mcpErrorStatus(cause);
      await this.#release(key, lease.connection, isDeadMcpSessionFailure(cause));
      if (lease.reused && status === 404) {
        lease = await this.#acquire(key, connect, true);
        try {
          const result = await use(lease.connection);
          await this.#release(key, lease.connection, false);
          return result;
        } catch (retryCause) {
          await this.#release(key, lease.connection, isDeadMcpSessionFailure(retryCause));
          throw retryCause;
        }
      }
      throw cause;
    }
  }

  async close(): Promise<void> {
    const connections = [...this.#idle.values()].map((entry) => entry.connection);
    this.#idle.clear();
    await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
  }
}

export function mcpErrorStatus(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const record = cause as Record<string, unknown>;
  for (const key of ["status", "statusCode", "httpStatus"]) {
    if (typeof record[key] === "number") return record[key];
  }
  if (record.cause !== cause) {
    const nested = mcpErrorStatus(record.cause);
    if (nested !== undefined) return nested;
  }
  const message = cause instanceof Error ? cause.message : "";
  const match = /(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})/iu.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

export function isDeadMcpSessionFailure(cause: unknown): boolean {
  const status = mcpErrorStatus(cause);
  if (status !== undefined) return [400, 401, 404, 408].includes(status);
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>;
    if (typeof record.transportFailure === "boolean") return record.transportFailure;
    if (record.name === "McpError" || cause.constructor?.name === "McpError") return false;
  }
  return true;
}
