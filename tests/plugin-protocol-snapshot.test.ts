import { expect, test } from "vitest";
import { protocolProblems } from "../scripts/plugin-engine/protocol-snapshot.ts";

// The recorded framework protocol is the one the framework speaks, and every property the Host
// started sending since the previous protocol is gated to bundles that accept it.
test("the framework protocol snapshot is current and its host additions are gated", () => {
  expect(protocolProblems()).toEqual([]);
});
