import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "../packages/integration-adapters/src/index.js";
import { getIntegrationDefinition } from "../packages/integration-catalog/src/index.js";
import { parseComputerAppConfig } from "../packages/integration-core/src/computer-app.js";
import { computerAppOperationContract } from "../packages/integration-core/src/computer-app-tools.js";
import { integrationDefinitionDigest } from "../packages/integration-core/src/digest.js";
import { generateAppleDataContracts } from "../scripts/generate-apple-data-contracts.js";

// Pinned at base 597e2e384; do not update these to accommodate new providers.
const baseDigests = {
  "apple-calendar": "Scd8aWIGu4M4WNeYlBfY2VmmKu3BDlEmtsubztyO78E",
  "apple-contacts": "S3UUcFG_nYQxmmuZ7V_KB3ksmR3zVEKsTBRy-FajfTY",
  "apple-reminders": "UziktIs5w2hTEcjUM-8FQLBL1PCmz7qMDZP4jJ5XAx4",
  "apple-messages": "8QjvDNYTOrV6CBeNoa2kvaDCo-35S6dn98ixH3h4uDA",
};
const newIds = ["iphone-location", "iphone-photos"] as const;

function config(id: string) {
  const definition = getIntegrationDefinition(id);
  expect(definition, `${id} must be in the real catalog`).toBeDefined();
  return parseComputerAppConfig(definition!);
}

describe("iPhone-only provider contracts", () => {
  it("preserves older Apple installations and compiles new contracts only into the iPhone", async () => {
    for (const [id, digest] of Object.entries(baseDigests)) {
      expect(integrationDefinitionDigest(getIntegrationDefinition(id)!)).toBe(digest);
    }
    const checkedIn = await readFile(
      new URL(
        "../packages/apple-data/Sources/OpensteerAppleData/Resources/contracts.json",
        import.meta.url,
      ),
    );
    await generateAppleDataContracts();
    const shared = await readFile(
      new URL(
        "../packages/apple-data/Sources/OpensteerAppleData/Resources/contracts.json",
        import.meta.url,
      ),
    );
    expect(shared).toEqual(checkedIn);
    expect(createHash("sha256").update(shared).digest("hex")).toBe(
      "76a94294995d172645009f98a6f36be80841bbe7bbf95095b9fa0b1102e5f6d4",
    );
    const iphone = await readFile(
      new URL(
        "../apps/mobile/modules/iphone-apps/ios/Sources/IphoneAppsCore/IphoneContracts.generated.swift",
        import.meta.url,
      ),
      "utf8",
    );
    for (const id of newIds) {
      expect(shared.toString()).not.toContain(id);
      const provider = config(id);
      expect(provider.platforms).toEqual(["ios"]);
      for (const operation of provider.operations) {
        expect(operation.effect).toBe("read");
        expect(iphone).toContain(computerAppOperationContract(operation));
      }
    }
  });

  it("bounds location freshness and exposes accuracy without a write or background tool", () => {
    const provider = config("iphone-location");
    expect(provider.operations.map(({ name }) => name)).toEqual(["current_location"]);
    const operation = provider.operations[0]!;
    for (const input of [{}, { maxAgeSeconds: 0 }, { maxAgeSeconds: 300 }])
      expect(validateJsonSchema(operation.inputSchema, input)).toEqual([]);
    for (const input of [
      { maxAgeSeconds: -1 },
      { maxAgeSeconds: 301 },
      { maxAgeSeconds: 1.5 },
      { background: true },
    ])
      expect(validateJsonSchema(operation.inputSchema, input).length).toBeGreaterThan(0);
    const fix = {
      latitude: 40,
      longitude: -74,
      horizontalAccuracyMeters: 1000,
      capturedAt: "2026-10-28T12:00:00Z",
      accuracy: "approximate",
    };
    expect(validateJsonSchema(operation.outputSchema!, fix)).toEqual([]);
    expect(
      validateJsonSchema(operation.outputSchema!, { ...fix, latitude: 91 }).length,
    ).toBeGreaterThan(0);
  });

  it("offers bounded metadata pages and excludes photo bytes and location", () => {
    const provider = config("iphone-photos");
    expect(provider.operations.map(({ name }) => name)).toEqual(["list_assets", "list_albums"]);
    const operation = provider.operations[0]!;
    expect(
      validateJsonSchema(operation.inputSchema, { limit: 100, mediaKinds: ["live-photo"] }),
    ).toEqual([]);
    for (const input of [
      { limit: 101 },
      { cursor: "x".repeat(2049) },
      { download: true },
      { mediaKinds: ["audio"] },
    ])
      expect(validateJsonSchema(operation.inputSchema, input).length).toBeGreaterThan(0);
    const asset = {
      id: "asset-1",
      createdAt: null,
      modifiedAt: null,
      mediaKind: "image",
      width: 100,
      height: 100,
      durationSeconds: null,
      favorite: false,
    };
    const page = { scope: "selected", assets: [asset], nextCursor: null };
    expect(validateJsonSchema(operation.outputSchema!, page)).toEqual([]);
    for (const forbidden of [{ bytes: "aGVsbG8=" }, { latitude: 40 }, { filename: "IMG.jpg" }])
      expect(
        validateJsonSchema(operation.outputSchema!, {
          ...page,
          assets: [{ ...asset, ...forbidden }],
        }).length,
      ).toBeGreaterThan(0);
    expect(
      validateJsonSchema(operation.outputSchema!, {
        ...page,
        assets: Array.from({ length: 101 }, () => asset),
      }).length,
    ).toBeGreaterThan(0);
  });

  it("accepts bounded album cursors large enough for a non-ASCII title", () => {
    const operation = config("iphone-photos").operations.find(
      ({ name }) => name === "list_albums",
    )!;
    const title = "相".repeat(256);
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, q: "a".repeat(64), at: title, id: "album-1" }),
    ).toString("base64url");
    expect(cursor.length).toBeGreaterThan(512);
    expect(validateJsonSchema(operation.inputSchema, { cursor })).toEqual([]);
    expect(
      validateJsonSchema(operation.outputSchema!, {
        scope: "selected",
        albums: [{ id: "album-1", title, assetCount: 1 }],
        nextCursor: cursor,
      }),
    ).toEqual([]);
    expect(
      validateJsonSchema(operation.outputSchema!, {
        scope: "selected",
        albums: [{ id: "emoji", title: "👩🏽‍💻".repeat(36), assetCount: 1 }],
        nextCursor: null,
      }),
    ).toEqual([]);
    expect(
      validateJsonSchema(operation.outputSchema!, {
        scope: "selected",
        albums: [{ id: "emoji", title: "👩🏽‍💻".repeat(37), assetCount: 1 }],
        nextCursor: null,
      }).length,
    ).toBeGreaterThan(0);
  });
});
