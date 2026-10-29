/**
 * The control commands a Runner records once by command ID. One whose
 * delivery is uncertain — a connection lost after sending it, a Host stopped
 * after claiming it — is sent again until it is confirmed or its Run ends, so
 * a lost connection, a Host restart and the Run's end treat it alike. A steer
 * is never resent: whether it reached the engine is unknown, and delivering it
 * twice would put the message in twice.
 */
export const resendableControlCommandTypes = [
  "request.respond",
  "run.interrupt",
  "run.restart",
] as const;

export function isResendableControlCommand(type: string): boolean {
  return (resendableControlCommandTypes as readonly string[]).includes(type);
}
