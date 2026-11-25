// The limits on a connected agent's (and a Run's) path to a browser, in the order they meet an
// answer: the router beside the browser holds an agent's answer to agentCdpMessageMaxBytes and
// fails only that command when it is larger; every hop after it can only close its socket over
// its own limit, so each must carry more than the router ever passes, and the router is always
// the one that answers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
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
  ["apps/host/src/browser/browser-service.ts", "maxBrowserTextBytes"],
  ["apps/host/src/browser/trigger-cdp-bridge.ts", "maximumCdpMessageBytes"],
  ["apps/runner/src/browser/browser-cdp-relay.ts", "maximumFrameBytes"],
  ["apps/runner/browser-harness/cdp.mjs", "MAX_MESSAGE_BYTES"],
])("carries more than the router ever passes at %s (%s)", (file, name) => {
  // An answer the router passes, with room for the frame around it.
  expect(stated(file, name)).toBeGreaterThanOrEqual(agentCdpMessageMaxBytes + 64 * 1_024);
});
