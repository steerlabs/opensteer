/**
 * What adding an Opensteer by its address says when it fails. The Home's own reasons
 * cross Electron's bridge with Electron's prefix; these are the ones a person can act
 * on, and anything else keeps the general sentence rather than an internal one.
 */
const addressReasons: readonly string[] = [
  "That address needs https.",
  "That address belongs to a computer reached by Remote access. Pair it with a pairing code from that computer.",
  "This Opensteer has no owner yet. Open the setup link from your server to claim it.",
];

export const desktopConnectFallback =
  "That couldn’t be connected. Check the address and try again.";

export function desktopConnectFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const own = message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, "").trim();
  return addressReasons.includes(own) ? own : desktopConnectFallback;
}
