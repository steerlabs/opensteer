import type {
  OpensteerTransportProbeOutput,
  TransportProbeLevel,
  TransportProbeResult,
} from "@opensteer/protocol";

export const TRANSPORT_PROBE_LADDER = [
  "direct-http",
  "matched-tls",
  "context-http",
  "page-http",
  "session-http",
] as const satisfies readonly TransportProbeLevel[];

export function selectTransportProbeRecommendation(
  results: readonly TransportProbeResult[],
): OpensteerTransportProbeOutput["recommendation"] {
  return (
    results.find((entry) => entry.success)?.transport ??
    results.at(-1)?.transport ??
    "session-http"
  );
}
