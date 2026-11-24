/**
 * One source's share of a listener's connections (review S1a). The pool host's relay and agent
 * port serve every Home on the host; without a share per source, one Home (or one Run in it that
 * an attacker steers) could hold every connection the listener allows and deny the others. A
 * connection over its source's share is closed as soon as it is accepted, before any TLS
 * handshake or request is read; one without an address is refused, never counted together.
 */
import type { EventEmitter } from "node:events";

interface CountedSocket extends EventEmitter {
  readonly remoteAddress?: string | undefined;
  destroy(): void;
}

export function limitConnectionsPerSource(server: EventEmitter, perSource: number): void {
  const open = new Map<string, number>();
  server.prependListener("connection", (socket: CountedSocket) => {
    const source = socket.remoteAddress;
    if (!source) return void socket.destroy();
    const count = open.get(source) ?? 0;
    if (count >= perSource) return void socket.destroy();
    open.set(source, count + 1);
    socket.once("close", () => {
      const left = (open.get(source) ?? 1) - 1;
      if (left <= 0) open.delete(source);
      else open.set(source, left);
    });
  });
}
