import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "ios", Version: 26 }));
vi.mock("react-native", () => ({ Platform: platform }));
afterEach(() => vi.resetModules());

describe.each([
  { os: "ios", version: 16, inset: true, lift: true },
  { os: "ios", version: 26, inset: true, lift: true },
  { os: "android", version: 24, inset: false, lift: false },
  { os: "android", version: 28, inset: false, lift: true },
  { os: "android", version: 29, inset: true, lift: true },
])("materials on $os $version", ({ os, version, inset, lift }) => {
  it("keeps reading surfaces opaque and uses only supported edge rendering", async () => {
    Object.assign(platform, { OS: os, Version: version });
    const { color, material } = await import("./theme.js");
    for (const face of [
      material.plate,
      material.control,
      material.selected,
      material.accent,
      material.destructive,
      material.attention,
      material.float,
    ]) {
      expect(face.backgroundColor).toMatch(/^#[\da-f]{6}$/i);
      expect(face.borderWidth).toBe(1);
      const shadows = typeof face.boxShadow === "string" ? [] : (face.boxShadow ?? []);
      expect(shadows.filter((shadow) => shadow.inset)).toHaveLength(inset ? 1 : 0);
      if (!inset) expect(face.borderTopColor).toBeDefined();
    }
    expect(material.float.backgroundColor).toBe(color.surfaceElevated);
    expect(material.control.borderColor).toBe(color.lineControl);
    expect(material.float.boxShadow.filter((shadow) => !shadow.inset)).toHaveLength(lift ? 1 : 0);
    for (const face of [material.plate, material.accent, material.attention]) {
      const shadows = typeof face.boxShadow === "string" ? [] : (face.boxShadow ?? []);
      expect(shadows.every((shadow) => shadow.inset)).toBe(true);
    }
    const rim = String(material.accent.borderColor);
    for (const offset of [1, 3, 5]) {
      const channel = (hex: string) => Number.parseInt(hex.slice(offset, offset + 2), 16);
      expect(channel(rim)).toBeGreaterThan(channel(color.inkOnEmber));
      expect(channel(rim)).toBeLessThan(channel(color.ember));
    }
    expect(material.accentPressed.boxShadow).toHaveLength(0);
    expect(material.platePressed.boxShadow).toHaveLength(0);
  });
});
