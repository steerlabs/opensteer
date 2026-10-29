import { describe, expect, it } from "vitest";
import {
  BrowserProfileSnapshotSchema,
  decodeBrowserProfileSnapshot,
  encodeBrowserProfileSnapshot,
  maxBrowserProfileSnapshotBytes,
  captureBrowserProfileSnapshot,
  type BrowserOriginCaptureFailure,
} from "./snapshot.js";
import { browserStorageOperation } from "./storage-operation.js";

describe("portable browser profile snapshot", () => {
  it("accepts the shared Playwright and Electron IndexedDB representation", () => {
    const snapshot = BrowserProfileSnapshotSchema.parse({
      cookies: [
        {
          domain: "example.test",
          expires: -1,
          httpOnly: true,
          name: "session",
          partitionKey: "https://top-level.test",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: "opaque",
        },
      ],
      origins: [
        {
          indexedDB: [
            {
              name: "authentication",
              stores: [
                {
                  autoIncrement: false,
                  indexes: [],
                  name: "tokens",
                  records: [
                    { key: "plain", value: { token: "one" } },
                    {
                      keyEncoded: "encoded-key",
                      valueEncoded: { o: [{ k: "count", v: { bi: "2" } }], id: 1 },
                    },
                  ],
                },
              ],
              version: 1,
            },
          ],
          localStorage: [{ name: "theme", value: "dark" }],
          origin: "https://example.test",
        },
      ],
    });

    expect(decodeBrowserProfileSnapshot(encodeBrowserProfileSnapshot(snapshot))).toEqual(snapshot);
  });

  it("rejects non-origin storage keys and oversized encoded snapshots", () => {
    expect(() =>
      BrowserProfileSnapshotSchema.parse({
        cookies: [],
        origins: [{ localStorage: [], origin: "https://example.test/path" }],
      }),
    ).toThrow(/origin/i);
    expect(() =>
      decodeBrowserProfileSnapshot(new Uint8Array(maxBrowserProfileSnapshotBytes + 1)),
    ).toThrow(/64 MiB/);
  });

  it("is self-contained when serialized into a Chromium isolated world", () => {
    const factory = new Function(
      `return (${browserStorageOperation.toString()});`,
    ) as () => unknown;
    expect(factory()).toBeTypeOf("function");
  });
});

describe("origin capture boundaries", () => {
  const origin = "https://large.test";
  const large = {
    origin,
    localStorage: [{ name: "large", value: "界".repeat(3 * 1_024 * 1_024) }],
  };
  it("round-trips legitimate multi-MiB keys and values, including JSON expansion", () => {
    for (const entry of [
      large,
      {
        origin,
        localStorage: [
          { name: "x".repeat(100_000), value: "\0".repeat(5 * 1_024 * 1_024 - 100_000) },
        ],
      },
    ]) {
      const snapshot = BrowserProfileSnapshotSchema.parse({ cookies: [], origins: [entry] });
      expect(decodeBrowserProfileSnapshot(encodeBrowserProfileSnapshot(snapshot))).toEqual(
        snapshot,
      );
    }
  });
  it("counts the whole origin's UTF-16 keys and values and refuses duplicate keys", () => {
    const full = {
      origin,
      localStorage: [{ name: "x", value: "a".repeat(5 * 1_024 * 1_024 - 1) }],
    };
    expect(BrowserProfileSnapshotSchema.safeParse({ cookies: [], origins: [full] }).success).toBe(
      true,
    );
    for (const entries of [
      [...full.localStorage, { name: "y", value: "" }],
      [
        { name: "x", value: "a" },
        { name: "x", value: "b" },
      ],
    ])
      expect(
        BrowserProfileSnapshotSchema.safeParse({
          cookies: [],
          origins: [{ origin, localStorage: entries }],
        }).success,
      ).toBe(false);
  });
  it("saves valid sites and cookies, retains rejected sites, and reports every rejection", () => {
    const failures: BrowserOriginCaptureFailure[] = [];
    const previous = {
      cookies: [],
      origins: [{ origin, localStorage: [{ name: "prior", value: "saved" }] }],
    };
    const normal = { origin: "https://normal.test", localStorage: [{ name: "ok", value: "new" }] };
    const snapshot = captureBrowserProfileSnapshot({
      cookies: [],
      origins: [
        normal,
        { ...large, localStorage: [{ name: "huge", value: "x".repeat(6 * 1_024 * 1_024) }] },
        { origin: "https://bad.test/path", localStorage: [] },
      ],
      previous,
      onOriginFailure: (failure) => failures.push(failure),
    });
    expect(snapshot.origins).toEqual([normal, ...previous.origins]);
    expect(failures).toEqual([
      { origin, reason: "invalid", retained: true },
      { origin: null, reason: "invalid", retained: false },
    ]);
    expect(() =>
      captureBrowserProfileSnapshot({
        cookies: [],
        origins: [{ origin, localStorage: null }],
        previous,
      }),
    ).toThrow(/incomplete/i);
  });
  it("isolates the encoded envelope budget without displacing prior sites", () => {
    const failures: BrowserOriginCaptureFailure[] = [];
    const origins = Array.from({ length: 3 }, (_, index) => ({
      origin: `https://budget-${index}.test`,
      localStorage: [{ name: "x", value: "\0".repeat(5 * 1_024 * 1_024 - 1) }],
    }));
    const snapshot = captureBrowserProfileSnapshot({
      cookies: [],
      origins,
      previous: { cookies: [], origins: [] },
      onOriginFailure: (f) => failures.push(f),
    });
    expect(snapshot.origins).toHaveLength(2);
    expect(failures).toEqual([
      { origin: origins[2]!.origin, reason: "snapshot-size", retained: false },
    ]);
    expect(encodeBrowserProfileSnapshot(snapshot).byteLength).toBeLessThanOrEqual(
      maxBrowserProfileSnapshotBytes,
    );
  });
});
