import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The signal a handler watches to stop working once nobody is listening.
 *
 * Long reads — a workspace file download, a streamed rpc result — outlive the
 * client that asked for them often enough that the cancellation contract has to
 * be identical on both paths, so the rpc group and the REST routes derive their
 * signal here. The listeners are removed once the response finishes: a handler
 * that never aborts must not leave a subscription on a socket the server keeps
 * alive for the next request.
 */
export function requestAbortSignal(
  request: IncomingMessage,
  response: ServerResponse,
): AbortSignal {
  const controller = new AbortController();
  const cleanup = () => {
    request.off("aborted", abort);
    response.off("close", abort);
    response.off("finish", cleanup);
  };
  const abort = () => {
    cleanup();
    controller.abort(new Error("Client disconnected"));
  };
  if (request.aborted || response.destroyed) {
    abort();
    return controller.signal;
  }
  request.once("aborted", abort);
  response.once("close", abort);
  response.once("finish", cleanup);
  return controller.signal;
}
