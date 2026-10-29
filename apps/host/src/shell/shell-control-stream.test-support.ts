import { OpensteerError } from "@opensteer/core";
import type { ShellSessionId } from "@opensteer/protocol";
import type { ShellControlStreamHandler } from "./shell-control-stream.js";

/**
 * The `shell` control stream with no session routing behind it.
 *
 * The stream itself is real: a machine that advertises `shell` attaches, proves
 * its fence and renews its lease exactly like the other modules, which is what
 * makes the module routable and revocable at all. What is absent is the hub, so
 * this Host has no sessions — a session message is a Runner reporting on
 * something this Host never asked for, and saying so is more honest than
 * dropping it, while every ending is vacuously already done.
 *
 * Only assembled servers that do not route shell sessions use it, which today
 * means tests: the real Host always has a hub.
 */
export const unroutedShellControlStream: ShellControlStreamHandler = {
  attach: () => undefined,
  attachCaller: (_sessionId, socket) => socket.close(1011, "no shell session"),
  attachDataSocket: (_sessionId, socket) => socket.close(1011, "no shell session"),
  claimDataSocket: () => Promise.reject(unopened("host.shell.session.open")),
  connect: () => Promise.reject(unopened("host.shell.session.open")),
  detach: () => undefined,
  detachRunner: () => undefined,
  end: () => Promise.resolve({ ended: false }),
  endMachineSessions: () => Promise.resolve(),
  endRunSessions: () => Promise.resolve(),
  handleMessage: (_peer, _stream, message) => Promise.reject(unopened(message.type)),
  liveSessionBytes: () =>
    new Map<ShellSessionId, { readonly bytesIn: number; readonly bytesOut: number }>(),
  renew: () => undefined,
  withMachineAdmission: async (_runnerId, task) => task(),
};

function unopened(what: string): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: `This Host opened no shell session, so ${what} is unexpected`,
  });
}
