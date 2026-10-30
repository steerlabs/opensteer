import { z } from "zod";
// Keep complete client flights for fragmented TLS ClientHello reassembly, but no ZIP responses.
export const captureFilter =
  "port 53 or tcp dst port 80 or tcp dst port 443 or tcp dst port 853 or (dst host 127.0.0.2 and tcp[tcpflags] & tcp-syn != 0)";
export const captureScope =
  "Guest-wide DNS and client-to-server TCP metadata with zero drops; PF separately blocks all non-loopback IPv4/IPv6 egress except the existing SSH control four-tuple.";
export function captureCounters(log: string) {
  const count = (expression: RegExp) =>
    z.coerce.number().int().nonnegative().parse(expression.exec(log)?.[1]);
  return {
    captured: count(/(\d+) packets captured/u),
    received: count(/(\d+) packets received by filter/u),
    dropped: count(/(\d+) packets dropped by kernel/u),
  };
}
