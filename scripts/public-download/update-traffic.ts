import assert from "node:assert/strict";
import { z } from "zod";
export const mirrorHosts = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Validate the actual server socket addresses and public-provider request shape. */
export function validateMirrorRequests(log: string, channel: "beta" | "stable") {
  const events = log
    .split("\n")
    .filter(Boolean)
    .map((s) =>
      z
        .object({
          host: z.string().optional(),
          tlsSni: z.string().optional(),
          path: z.string().optional(),
          authenticated: z.boolean().optional(),
          localAddress: z.string().optional(),
          remoteAddress: z.string().optional(),
          accept: z.string().optional(),
          transferComplete: z.string().optional(),
        })
        .parse(JSON.parse(s)),
    );
  assert(!events.some((e) => e.tlsSni === "api.github.com"), "Unexpected API TLS attempt");
  const requests = events.filter((e) => e.host !== undefined);
  assert(requests.length, "No measured mirror requests");
  for (const request of requests) {
    assert(
      mirrorHosts.some((h) => h === request.host),
      "Unexpected API or external host",
    );
    assert.equal(request.authenticated, false, "Public provider must not send a token");
    assert(
      loopback.has(request.localAddress ?? "") && loopback.has(request.remoteAddress ?? ""),
      "Request must use mirror loopback addresses",
    );
    if (request.path === "/steerlabs/opensteer/releases/latest")
      assert.equal(request.accept, "application/json");
  }
  assert(
    requests.some(
      (r) => r.host === "github.com" && r.path === "/steerlabs/opensteer/releases.atom",
    ),
    "Missing public Atom request",
  );
  if (channel === "stable")
    assert(
      requests.some((r) => r.path === "/steerlabs/opensteer/releases/latest"),
      "Missing public Latest request",
    );
  assert(
    requests.some((r) =>
      r.path?.endsWith(channel === "beta" ? "/insider-mac.yml" : "/latest-mac.yml"),
    ),
    "Missing channel metadata request",
  );
  assert(
    events.some((r) => r.transferComplete?.endsWith(".zip")),
    "Missing delivered update ZIP",
  );
  return { passed: true, mirrorHosts, requests };
}
