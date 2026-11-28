/**
 * One source's share of a listener's connections (review S1a). The pool host's relay and agent
 * port serve every Home on the host; without a share per source, one Home (or one Run in it that
 * an attacker steers) could hold every connection the listener allows and deny the others. A
 * connection over its source's share is closed as soon as it is accepted, before any TLS
 * handshake or request is read; one without an address is refused, never counted together.
 * What a share refuses is counted and said at most once a minute per source, so a real Home's
 * peak can be read against its share.
 */
import type { EventEmitter } from "node:events";

interface CountedSocket extends EventEmitter {
  readonly remoteAddress?: string | undefined;
  destroy(): void;
}

export interface ShareReport {
  /** Which listener ("relay", "agent"), for the log line. */
  readonly listener: string;
  readonly log: (line: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => number;
}

const reportEveryMs = 60_000;

export function limitConnectionsPerSource(
  server: EventEmitter,
  perSource: number,
  report?: ShareReport,
): void {
  const open = new Map<string, number>();
  const refused = new Map<string, { pending: number; saidAt?: number }>();
  const refuse = (socket: CountedSocket, source: string | undefined) => {
    socket.destroy();
    if (!report || !source) return;
    const now = (report.now ?? Date.now)();
    const count = refused.get(source) ?? { pending: 0 };
    count.pending += 1;
    if (count.saidAt === undefined || now - count.saidAt >= reportEveryMs) {
      report.log({
        event: "pool.share.refused",
        listener: report.listener,
        source,
        share: perSource,
        refused: count.pending,
      });
      count.pending = 0;
      count.saidAt = now;
    }
    refused.set(source, count);
  };
  server.prependListener("connection", (socket: CountedSocket) => {
    const source = socket.remoteAddress;
    if (!source) return refuse(socket, source);
    const count = open.get(source) ?? 0;
    if (count >= perSource) return refuse(socket, source);
    open.set(source, count + 1);
    socket.once("close", () => {
      const left = (open.get(source) ?? 1) - 1;
      if (left <= 0) open.delete(source);
      else open.set(source, left);
    });
  });
}
