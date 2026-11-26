// The limits on a connected agent's (and a Run's) path to a browser, in the order they meet an
// answer: the router beside the browser holds an agent's answer to agentCdpMessageMaxBytes and
// fails only that command when it is larger; every hop after it can only close its socket over
// its own limit, so each must carry more than the router ever passes, and the router is always
// the one that answers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { computerReplLimits } from "../apps/host/src/computer-use/computer-repl/messages.js";
import { boundedJsonSize } from "../packages/browser-core/src/bounded-json.js";
import { agentCdpMessageMaxBytes } from "../packages/browser-core/src/standard-cdp-limits.js";
import { agentToolPayloadMaxSerializedBytes } from "../packages/protocol/src/common.js";

const root = join(import.meta.dirname, "..");

/** A hop's limit as its file states it: `const NAME = <digits, _ and *>;`. */
function stated(file: string, name: string): number {
  const match = new RegExp(`^const ${name} = ([0-9_ *]+);$`, "mu").exec(
    readFileSync(join(root, file), "utf8"),
  );
  if (!match?.[1]) throw new Error(`${file} states no ${name}`);
  return match[1]
    .split("*")
    .map((factor) => Number(factor.trim().replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
}

it("holds an agent's CDP answer to an agent tool payload's own ceiling, 432 KiB", () => {
  expect(agentCdpMessageMaxBytes).toBe(432 * 1_024);
  expect(agentCdpMessageMaxBytes).toBe(agentToolPayloadMaxSerializedBytes);
});

it.each([
  // From the browser outwards, then from the Host to a Run's harness.
  ["apps/host/src/browser/managed-pool-home.ts", "maxPooledGuestTextFrameBytes"],
  ["packages/runner-client/src/browser-relay.ts", "maxRelayTextEnvelopeBytes"],
  ["apps/host/src/browser/browser-service.ts", "maxBrowserTextBytes"],
  ["apps/host/src/browser/trigger-cdp-bridge.ts", "maximumCdpMessageBytes"],
  ["apps/runner/src/browser/browser-cdp-relay.ts", "maximumFrameBytes"],
  ["apps/runner/browser-harness/cdp.mjs", "MAX_MESSAGE_BYTES"],
])("carries more than the router ever passes at %s (%s)", (file, name) => {
  // An answer the router passes, with room for the frame around it.
  expect(stated(file, name)).toBeGreaterThanOrEqual(agentCdpMessageMaxBytes + 64 * 1_024);
});

it("measures an escaped CDP answer on the wire before it can reach a socket's limit", () => {
  const budget = { maxBytes: agentCdpMessageMaxBytes, maxDepth: 16, maxEntries: 128 };
  const result = { result: { type: "string", value: "" } };
  const emptyBytes = Buffer.byteLength(JSON.stringify(result));
  result.result.value = '"'.repeat(Math.floor((budget.maxBytes - emptyBytes) / 2));
  const measured = Buffer.byteLength(JSON.stringify(result));
  expect(measured).toBeGreaterThan(budget.maxBytes - 2);
  expect(boundedJsonSize(result, budget)).toBe(measured);
  const message = { type: "cdp.result", requestId: "f".repeat(36), result };
  const relay = {
    type: "browser.server-message",
    runnerId: "rnr_" + "f".repeat(36),
    auxiliaryStreamId: "rax_" + "f".repeat(36),
    module: "browser",
    channelId: "bch_" + "f".repeat(36),
    capability: {
      runtimeId: "browser-main",
      capabilityGeneration: 1,
      capabilityLeaseId: "bcl_" + "f".repeat(36),
    },
    message,
  };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  expect(bytes(message)).toBeLessThan(
    stated("apps/host/src/browser/managed-pool-home.ts", "maxPooledGuestTextFrameBytes"),
  );
  expect(bytes(relay)).toBeLessThan(
    stated("packages/runner-client/src/browser-relay.ts", "maxRelayTextEnvelopeBytes"),
  );
  // The REPL can carry JSON as a string. Allow room even for this second round of escaping.
  expect(bytes({ result: JSON.stringify(message) })).toBeLessThan(computerReplLimits.bridgeBytes);
  result.result.value += '"';
  expect(boundedJsonSize(result, budget)).toBeUndefined();
});
