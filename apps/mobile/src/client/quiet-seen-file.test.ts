import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it, vi } from "vitest";
import { createQuietSeen } from "./quiet-seen-file.js";

const filePath = "/private/quiet-seen.json";

async function loaded(privateFiles: MemoryPrivateFilesystem) {
  const seen = createQuietSeen({ filePath, privateFiles });
  await vi.waitFor(() => expect(seen.getSnapshot(), "the file never answered").not.toBeNull(), {
    timeout: 1_000,
  });
  return seen;
}

async function stored(privateFiles: MemoryPrivateFilesystem): Promise<unknown> {
  const bytes = await privateFiles.readFile(filePath, 4_096);
  return bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

describe("createQuietSeen", () => {
  it("has shown nothing when the file is missing, malformed or too large", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    expect((await loaded(privateFiles)).getSnapshot()).toEqual({});

    await privateFiles.writeFileAtomic(filePath, "not-json");
    expect((await loaded(privateFiles)).getSnapshot()).toEqual({});

    await privateFiles.writeFileAtomic(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        seen: { a: "2026-11-01T00:00:00.000Z", pad: "x".repeat(5_000) },
      }),
    );
    expect((await loaded(privateFiles)).getSnapshot()).toEqual({});
  });

  it("only moves forward, and keeps what it saw across launches", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const seen = await loaded(privateFiles);
    seen.see("deployment:user", "2026-11-02T00:00:00.000Z");
    seen.see("deployment:user", "2026-11-01T00:00:00.000Z");
    expect(seen.getSnapshot()).toEqual({ "deployment:user": "2026-11-02T00:00:00.000Z" });
    await vi.waitFor(
      async () =>
        expect(await stored(privateFiles), "the newer time was never saved").toEqual({
          schemaVersion: 1,
          seen: { "deployment:user": "2026-11-02T00:00:00.000Z" },
        }),
      { timeout: 1_000 },
    );
    expect((await loaded(privateFiles)).getSnapshot()).toEqual({
      "deployment:user": "2026-11-02T00:00:00.000Z",
    });
  });

  it("keeps a sighting made before the file answered, and forgets the oldest scopes", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const seen = createQuietSeen({ filePath, privateFiles });
    seen.see("early", "2026-11-03T00:00:00.000Z");
    await vi.waitFor(() => expect(seen.getSnapshot(), "the file never answered").not.toBeNull(), {
      timeout: 1_000,
    });
    expect(seen.getSnapshot()).toEqual({ early: "2026-11-03T00:00:00.000Z" });

    for (let index = 0; index < 16; index += 1)
      seen.see(`scope-${index}`, "2026-11-04T00:00:00.000Z");
    const scopes = Object.keys(seen.getSnapshot() ?? {});
    expect(scopes).toHaveLength(16);
    expect(scopes).not.toContain("early");
  });
});
