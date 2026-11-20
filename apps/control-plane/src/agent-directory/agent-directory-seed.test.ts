import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentDirectoryDocumentSchema,
  AgentDirectoryEntrySchema,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import { applyAgentDirectoryChange, type AgentDirectorySnapshot } from "./store.js";

const seedPath = resolve(
  import.meta.dirname,
  "../../../../deploy/account/agent-directory.seed.json",
);

describe("deploy/account/agent-directory.seed.json", () => {
  it("contains valid, disjoint day-one entries accepted by the protocol schema and operator store", () => {
    const raw = JSON.parse(readFileSync(seedPath, "utf8")) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    const items = raw as readonly unknown[];
    expect(items.length).toBeGreaterThan(0);

    const parsedEntries = items.map((item) => {
      const entry = AgentDirectoryEntrySchema.parse(item);
      expect(entry.keys).toBeUndefined();
      expect(entry.embedsVia).toBeUndefined();
      return entry;
    });

    const document = AgentDirectoryDocumentSchema.parse({
      revision: 1,
      issuedAt: "2026-11-20T00:00:00.000Z",
      entries: parsedEntries,
    });
    expect(document.entries).toHaveLength(items.length);

    let snapshot: AgentDirectorySnapshot = { revision: 1, entries: [] };
    const now = new Date("2026-11-20T00:00:00.000Z");
    for (const item of items) {
      const next = applyAgentDirectoryChange(snapshot, { kind: "add", input: item }, now);
      expect(next.revision).toBe(snapshot.revision + 1);
      snapshot = { revision: next.revision, entries: next.entries };
    }
    expect(snapshot.entries).toHaveLength(items.length);
  });
});
