import type { Server } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Stops a listening HTTP server and ends every HTTP connection it holds, idle
 * or partway through a request, instead of waiting for its peers. Settles
 * once the server has closed. The close also waits for upgraded and CONNECT
 * sockets, which are no longer the server's HTTP connections: their owner
 * ends those.
 */
export function closeHttpServerNow(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  // The listener stops first, so no connection accepted afterwards escapes the sweep.
  server.closeAllConnections();
  return closed;
}

/**
 * Answers an upgrade or CONNECT the server will not serve, then destroys the
 * socket at once. Such a socket has left the server's HTTP connections, yet
 * the server's close still waits for it, so it is never left for a peer that
 * may not end its own side. The answer is best effort.
 */
export function refuseConnection(socket: Duplex, statusCode: number, statusText: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
